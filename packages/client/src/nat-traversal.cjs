'use strict';
/**
 * Orchard NAT Traversal Ladder
 *
 * Attempts port mapping via:
 *   1. UPnP (IGD / SSDP + SOAP)
 *   2. NAT-PMP (RFC 6886)
 *   3. Falls back to relay-eligible flag
 *
 * Uses only Node.js built-ins (dgram, http, net) — no extra npm packages.
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');
const os = require('os');

const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const UPNP_SEARCH_TIMEOUT_MS = 3000;
const UPNP_SOAP_TIMEOUT_MS = 4000;
const NAT_PMP_PORT = 5351;
const NAT_PMP_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultGateway() {
  // Heuristic: find the first non-loopback IPv4 interface's likely gateway
  // by replacing the last octet with .1 (works for most home LANs).
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        if (parts.length === 4) {
          return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
        }
      }
    }
  }
  return '192.168.1.1';
}

function parseXmlValue(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// UPnP – SSDP discovery
// ---------------------------------------------------------------------------

/**
 * Sends an SSDP M-SEARCH and resolves with the first valid IGD location URL,
 * or null if nothing responds within the timeout.
 * @returns {Promise<string|null>}
 */
function discoverUpnpGateway() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => done(null), UPNP_SEARCH_TIMEOUT_MS);

    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
      '\r\n'
    );

    socket.on('error', () => done(null));
    socket.on('message', (buf) => {
      const text = buf.toString();
      const locationMatch = text.match(/^LOCATION:\s*(.+)$/im);
      if (locationMatch) {
        done(locationMatch[1].trim());
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_MULTICAST_ADDR, (err) => {
        if (err) done(null);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// UPnP – fetch device description + extract control URL
// ---------------------------------------------------------------------------

function httpGet(urlStr, timeoutMs = UPNP_SOAP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port || '80', 10),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    req.end();
  });
}

async function getUpnpControlUrl(locationUrl) {
  try {
    const xml = await httpGet(locationUrl);
    // Look for WANIPConnection or WANPPPConnection service
    const serviceMatch = xml.match(
      /<serviceType>[^<]*(?:WANIPConnection|WANPPPConnection)[^<]*<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i
    );
    if (!serviceMatch) return null;
    const controlPath = serviceMatch[1].trim();
    // Build absolute URL
    const base = new URL(locationUrl);
    if (controlPath.startsWith('http')) return controlPath;
    return `${base.protocol}//${base.host}${controlPath.startsWith('/') ? '' : '/'}${controlPath}`;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UPnP – SOAP AddPortMapping
// ---------------------------------------------------------------------------

function httpPost(urlStr, body, headers, timeoutMs = UPNP_SOAP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port || '80', 10),
      path: parsed.pathname,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    req.write(body);
    req.end();
  });
}

async function upnpAddPortMapping(controlUrl, internalHost, internalPort, externalPort, protocol = 'TCP') {
  const soapBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${externalPort}</NewExternalPort>
      <NewProtocol>${protocol}</NewProtocol>
      <NewInternalPort>${internalPort}</NewInternalPort>
      <NewInternalClient>${internalHost}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>Orchard</NewPortMappingDescription>
      <NewLeaseDuration>7200</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`;

  const result = await httpPost(controlUrl, soapBody, {
    'Content-Type': 'text/xml; charset="utf-8"',
    'SOAPAction': '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"',
    'Content-Length': Buffer.byteLength(soapBody),
  });

  if (result.status !== 200) {
    throw new Error(`UPnP SOAP error: HTTP ${result.status}`);
  }
  return true;
}

async function upnpGetExternalIp(controlUrl) {
  const soapBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetExternalIPAddress xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
    </u:GetExternalIPAddress>
  </s:Body>
</s:Envelope>`;

  const result = await httpPost(controlUrl, soapBody, {
    'Content-Type': 'text/xml; charset="utf-8"',
    'SOAPAction': '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"',
    'Content-Length': Buffer.byteLength(soapBody),
  });

  const ip = parseXmlValue(result.body, 'NewExternalIPAddress');
  return ip || null;
}

async function upnpDeletePortMapping(controlUrl, externalPort, protocol = 'TCP') {
  const soapBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:DeletePortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${externalPort}</NewExternalPort>
      <NewProtocol>${protocol}</NewProtocol>
    </u:DeletePortMapping>
  </s:Body>
</s:Envelope>`;

  await httpPost(controlUrl, soapBody, {
    'Content-Type': 'text/xml; charset="utf-8"',
    'SOAPAction': '"urn:schemas-upnp-org:service:WANIPConnection:1#DeletePortMapping"',
    'Content-Length': Buffer.byteLength(soapBody),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// NAT-PMP (RFC 6886) – UDP port mapping request
// ---------------------------------------------------------------------------

/**
 * Attempts a NAT-PMP port mapping for the given internal port.
 * @param {number} internalPort
 * @returns {Promise<{ externalHost: string, externalPort: number }|null>}
 */
function natPmpMap(internalPort) {
  return new Promise((resolve) => {
    const gateway = getDefaultGateway();
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => done(null), NAT_PMP_TIMEOUT_MS);

    // NAT-PMP request packet: version=0, opcode=2 (TCP), lifetime=7200s
    const req = Buffer.alloc(12);
    req.writeUInt8(0, 0);               // version
    req.writeUInt8(2, 1);               // opcode: map TCP
    req.writeUInt16BE(0, 2);            // reserved
    req.writeUInt16BE(internalPort, 4); // internal port
    req.writeUInt16BE(internalPort, 6); // suggested external port
    req.writeUInt32BE(7200, 8);         // lifetime (seconds)

    socket.on('error', () => done(null));
    socket.on('message', (buf) => {
      if (buf.length < 16) return done(null);
      const version = buf.readUInt8(0);
      const opcode = buf.readUInt8(1);
      const resultCode = buf.readUInt16BE(2);
      if (version !== 0 || opcode !== 130 /* 128+2 */ || resultCode !== 0) return done(null);
      const externalPort = buf.readUInt16BE(10);
      // Get our external IP separately – NAT-PMP doesn't include it in this response.
      // We'll return null host and let the caller use the public IP from the socket.
      done({ externalHost: null, externalPort });
    });

    socket.bind(() => {
      socket.send(req, 0, req.length, NAT_PMP_PORT, gateway, (err) => {
        if (err) done(null);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main entry point – NAT traversal ladder
// ---------------------------------------------------------------------------

/**
 * Attempts UPnP then NAT-PMP to open a mapping for the given port.
 * Returns a result describing what succeeded.
 *
 * @param {number} internalPort  The local file-server port to map.
 * @param {string} localHost     The local LAN IP of this machine.
 * @returns {Promise<{
 *   strategy: 'upnp-assist'|'nat-pmp'|'relay-fallback',
 *   externalHost: string|null,
 *   externalPort: number|null,
 *   relayEligible: boolean,
 *   upnpControlUrl: string|null,
 * }>}
 */
async function performNatLadder(internalPort, localHost) {
  // ── Step 1: UPnP ────────────────────────────────────────────────────────
  try {
    const locationUrl = await discoverUpnpGateway();
    if (locationUrl) {
      const controlUrl = await getUpnpControlUrl(locationUrl);
      if (controlUrl) {
        await upnpAddPortMapping(controlUrl, localHost, internalPort, internalPort);
        const externalHost = await upnpGetExternalIp(controlUrl);
        console.log(`[NAT] UPnP mapping succeeded: ${externalHost}:${internalPort}`);
        return {
          strategy: 'upnp-assist',
          externalHost,
          externalPort: internalPort,
          relayEligible: true,
          upnpControlUrl: controlUrl,
        };
      }
    }
  } catch (err) {
    console.warn('[NAT] UPnP failed:', err.message);
  }

  // ── Step 2: NAT-PMP ─────────────────────────────────────────────────────
  try {
    const result = await natPmpMap(internalPort);
    if (result) {
      console.log(`[NAT] NAT-PMP mapping succeeded: port ${result.externalPort}`);
      return {
        strategy: 'nat-pmp',
        externalHost: result.externalHost,
        externalPort: result.externalPort,
        relayEligible: true,
        upnpControlUrl: null,
      };
    }
  } catch (err) {
    console.warn('[NAT] NAT-PMP failed:', err.message);
  }

  // ── Step 3: Relay fallback ───────────────────────────────────────────────
  console.log('[NAT] No gateway mapping available; relay-eligible.');
  return {
    strategy: 'relay-fallback',
    externalHost: null,
    externalPort: null,
    relayEligible: true,
    upnpControlUrl: null,
  };
}

/**
 * Tear down a previously created UPnP mapping (call on app quit).
 * @param {string|null} controlUrl
 * @param {number} externalPort
 */
async function releaseUpnpMapping(controlUrl, externalPort) {
  if (!controlUrl || !externalPort) return;
  try {
    await upnpDeletePortMapping(controlUrl, externalPort);
    console.log(`[NAT] UPnP mapping released for port ${externalPort}`);
  } catch (err) {
    console.warn('[NAT] Failed to release UPnP mapping:', err.message);
  }
}

module.exports = { performNatLadder, releaseUpnpMapping };
