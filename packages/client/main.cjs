// main.cjs (Phase 2: UPnP/NAT-PMP ladder + relay-eligible reporting)
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { performNatLadder, releaseUpnpMapping } = require('./src/nat-traversal.cjs');

const isDev = !app.isPackaged;

// Preferred base port (override via FILE_SERVER_PORT env)
const PREFERRED_PORT = process.env.FILE_SERVER_PORT
  ? parseInt(process.env.FILE_SERVER_PORT, 10)
  : 5555;

let fileServer = null;
let actualPort = PREFERRED_PORT;
/** NAT traversal result from the last successful ladder attempt. */
let natResult = null;

// Per-session bearer token for the local file server — generated at startup.
// Rotated on every Electron launch so captured tokens expire when the app restarts.
const FILE_SERVER_TOKEN = crypto.randomBytes(32).toString('hex');

// Per-transfer single-use download tokens issued to approved requesters.
// Map<token, { fileRef: string, expiresAt: number }>
const downloadTokens = new Map();
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Periodically clean up expired per-transfer tokens.
setInterval(() => {
  const now = Date.now();
  for (const [tok, meta] of downloadTokens) {
    if (meta.expiresAt < now) downloadTokens.delete(tok);
  }
}, 60_000);

// Shared-file index: opaque fileRef -> absolute path (never shared with peers)
const allowedFiles = new Set();
const sharedFileIndex = new Map();
const relativePathIndex = new Map();
let folderWatcher = null;
let currentSharedFolder = null;

// Simple LAN host detection: choose first non-loopback IPv4 if available
function detectHost() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address; // e.g. 192.168.x.x
      }
    }
  }
  return '127.0.0.1';
}
const localHost = detectHost();

function startFileServer() {
  if (fileServer) return;

  fileServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }

    // Verify bearer token: accept the per-session token OR a valid per-transfer token.
    const authHeader = req.headers['authorization'] || '';
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const requestedRef = decodeURIComponent(req.url.slice(1));

    if (!providedToken) { res.writeHead(401); res.end('Unauthorized'); return; }

    let tokenOk = providedToken === FILE_SERVER_TOKEN;
    if (!tokenOk) {
      // Check per-transfer token (scoped to a specific file ref)
      const meta = downloadTokens.get(providedToken);
      if (meta && meta.expiresAt >= Date.now() && meta.fileRef === requestedRef) {
        tokenOk = true;
        // Single-use: remove after first successful auth check to prevent replays
        downloadTokens.delete(providedToken);
      }
    }
    if (!tokenOk) { res.writeHead(401); res.end('Unauthorized'); return; }
    console.log(`[File Server] Request for ref: ${requestedRef}`);

    if (!requestedRef || requestedRef.includes('\0')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const resolvedPath = resolveSharedFileReference(requestedRef);
    if (!resolvedPath) {
      console.log(`[File Server] Blocked non-shared file ref: ${requestedRef}`);
      res.writeHead(403); res.end('Forbidden'); return;
    }

    try {
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) { res.writeHead(403); res.end('Forbidden'); return; }
      const stream = fs.createReadStream(resolvedPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${path.basename(resolvedPath)}"`
      });
      stream.on('error', e => {
        console.error('[File Server] Stream error:', e);
        if (!res.headersSent) res.writeHead(500);
        res.end('Error');
      });
      stream.pipe(res);
      console.log(`[File Server] Served file: ${resolvedPath}`);
    } catch (e) {
      console.error('[File Server] Error serving file:', e);
      res.writeHead(404); res.end('Not Found');
    }
  });

  fileServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !fileServer._dynamicTried) {
      console.warn(`[File Server] Port ${PREFERRED_PORT} in use; trying dynamic port.`);
      fileServer._dynamicTried = true;
      fileServer.close();
      fileServer.listen(0); // Let OS choose
      return;
    }
    console.error('[File Server] Error event:', err);
  });

  fileServer.on('listening', () => {
    actualPort = fileServer.address().port;
    console.log(`[File Server] Listening on port ${actualPort} (host ${localHost})`);
    // Attempt NAT traversal after the file server is up.
    performNatLadder(actualPort, localHost)
      .then((result) => {
        natResult = result;
        console.log(`[NAT] Strategy: ${result.strategy} external=${result.externalHost}:${result.externalPort}`);
      })
      .catch((err) => {
        console.warn('[NAT] Ladder error:', err.message);
        natResult = { strategy: 'relay-fallback', externalHost: null, externalPort: null, relayEligible: true, upnpControlUrl: null };
      });
  });

  fileServer.listen(PREFERRED_PORT);
}

/**
 * Build an opaque peer-safe file reference from stable-ish file metadata.
 * Uses relative path + size + mtime to avoid exposing local absolute paths
 * while still producing deterministic references for unchanged files.
 */
function buildFileRef(relativePath, stats) {
  const inode = stats.ino || 0;
  return crypto
    .createHash('sha256')
    .update(`${relativePath}:${stats.size}:${Math.floor(stats.mtimeMs)}:${inode}`)
    .digest('hex')
    .slice(0, 32);
}

function resolveSharedFileReference(fileRefOrRelativePath) {
  if (typeof fileRefOrRelativePath !== 'string' || !fileRefOrRelativePath.trim()) return null;
  const ref = fileRefOrRelativePath.trim();
  const fromOpaqueRef = sharedFileIndex.get(ref);
  if (fromOpaqueRef && allowedFiles.has(fromOpaqueRef)) return fromOpaqueRef;
  const fromRelative = relativePathIndex.get(ref);
  if (fromRelative && allowedFiles.has(fromRelative)) return fromRelative;
  return null;
}

function scanDirectory(dirPath, rootDir = dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const tree = [];
  for (const entry of entries) {
    const p = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootDir, p).split(path.sep).join('/');
    if (entry.isDirectory()) {
      tree.push({
        id: `dir:${relativePath || entry.name}`,
        name: entry.name,
        type: 'directory',
        relativePath,
        children: scanDirectory(p, rootDir),
      });
    } else {
      try {
        const resolved = path.resolve(p);
        const stats = fs.statSync(p);
        const fileRef = buildFileRef(relativePath, stats);
        allowedFiles.add(resolved);
        sharedFileIndex.set(fileRef, resolved);
        relativePathIndex.set(relativePath, resolved);
        tree.push({
          id: fileRef,
          fileRef,
          name: entry.name,
          type: 'file',
          size: stats.size,
          path: fileRef, // backward compatibility for existing UI payload handling
          relativePath,
        });
      } catch (e) {
        console.error('[SCAN] stat error', p, e.message);
      }
    }
  }
  return tree;
}

function startFolderWatch(dirPath, win) {
  if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }
  currentSharedFolder = dirPath;
  let timeout = null;
  const rescan = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      allowedFiles.clear();
      sharedFileIndex.clear();
      relativePathIndex.clear();
      const tree = scanDirectory(dirPath);
      if (!win.isDestroyed()) win.webContents.send('update-file-list', tree);
    }, 600);
  };
  try {
    folderWatcher = fs.watch(dirPath, { recursive: true }, (evt, file) => {
      if (file) rescan();
    });
  } catch (e) {
    console.error('[WATCH] setup error:', e.message);
  }
}

async function handleFolderSelect(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (canceled || !filePaths.length) return null;
  const dirPath = filePaths[0];
  allowedFiles.clear();
  sharedFileIndex.clear();
  relativePathIndex.clear();
  const tree = scanDirectory(dirPath);
  if (!win.isDestroyed()) win.webContents.send('update-file-list', tree);
  startFolderWatch(dirPath, win);
  return dirPath;
}

// IPC
ipcMain.handle('dialog:openDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return await handleFolderSelect(win);
});
ipcMain.handle('file:getServerPort', () => actualPort);
ipcMain.handle('file:getHost', () => localHost);
ipcMain.handle('file:getNatResult', () => natResult);
ipcMain.handle('folder:stopSharing', () => {
  if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }
  currentSharedFolder = null;
  allowedFiles.clear();
  sharedFileIndex.clear();
  relativePathIndex.clear();
  return { success: true };
});
ipcMain.handle('folder:getCurrent', () => currentSharedFolder);
ipcMain.handle('dialog:selectFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});
ipcMain.handle('file:read', async (e, filePath) => {
  const resolved = path.resolve(filePath);
  // Guard: must be in the allowed set (populated only by scanDirectory of the shared folder)
  if (!allowedFiles.has(resolved)) {
    throw new Error('File not in shared set');
  }
  const data = fs.readFileSync(resolved);
  const stats = fs.statSync(resolved);
  return { data, name: path.basename(resolved), size: stats.size };
});
ipcMain.handle('telemetry:log', async (e, payload) => {
  console.log('[Telemetry]', JSON.stringify(payload || {}));
  return { success: true };
});
ipcMain.handle('app:setBadgeCount', async (_event, count) => {
  const nextCount = Math.max(0, Math.trunc(Number(count) || 0));
  if (typeof app.setBadgeCount === 'function') {
    app.setBadgeCount(nextCount);
  }
  if (process.platform === 'darwin' && app.dock?.setBadge) {
    app.dock.setBadge(nextCount > 0 ? String(nextCount) : '');
  }
  return { success: true, count: nextCount };
});
/**
 * Read a shared file in chunks for relay serving.
 * Returns null if the file is not in the allowed set.
 * Each chunk is a plain Buffer (serialized to Uint8Array by contextBridge).
 */
ipcMain.handle('file:readForRelay', async (e, { filePath, byteOffset, chunkSize }) => {
  const resolved = resolveSharedFileReference(filePath);
  if (!resolved) return null;
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isFile()) return null;
    const offset = Number(byteOffset || 0);
    const size = Number(chunkSize || 256 * 1024);
    const totalSize = stats.size;
    const fd = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(Math.min(size, Math.max(0, totalSize - offset)));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return { data: buf.slice(0, bytesRead), totalSize, name: path.basename(resolved) };
  } catch (err) {
    console.error('[file:readForRelay] error:', err.message);
    return null;
  }
});
ipcMain.handle('file:save', async (e, { fileData, fileName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: fileName,
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  fs.writeFileSync(filePath, Buffer.from(fileData));
  return { success: true, path: filePath };
});

// Expose the per-session file-server bearer token to the renderer
ipcMain.handle('file:getServerToken', () => FILE_SERVER_TOKEN);

/**
 * Generate a single-use, time-limited download token scoped to a specific file ref.
 * Called by the renderer when approving a peer's download request; the token is sent
 * to the requester via the broker so they can authenticate to our local file server.
 */
ipcMain.handle('file:generateDownloadToken', (_e, fileRef) => {
  if (typeof fileRef !== 'string' || !fileRef.trim()) return null;
  const ref = fileRef.trim();
  // Only issue tokens for files that are actually in the shared set
  const resolved = resolveSharedFileReference(ref);
  if (!resolved) return null;
  const token = crypto.randomBytes(32).toString('hex');
  downloadTokens.set(token, { fileRef: ref, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
  return token;
});

// JWT persistence: store and retrieve the auth token using safeStorage
ipcMain.handle('auth:storeToken', async (_e, token) => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      const tokenPath = path.join(app.getPath('userData'), 'auth-token.bin');
      fs.writeFileSync(tokenPath, encrypted);
    }
    return { success: true };
  } catch (err) {
    console.warn('[auth:storeToken] Failed to persist token:', err.message);
    return { success: false };
  }
});
ipcMain.handle('auth:getToken', async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const tokenPath = path.join(app.getPath('userData'), 'auth-token.bin');
    if (!fs.existsSync(tokenPath)) return null;
    const encrypted = fs.readFileSync(tokenPath);
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    console.warn('[auth:getToken] Failed to retrieve token:', err.message);
    return null;
  }
});
ipcMain.handle('auth:clearToken', async () => {
  try {
    const tokenPath = path.join(app.getPath('userData'), 'auth-token.bin');
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    return { success: true };
  } catch {
    return { success: false };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  if (isDev) {
    const port = process.env.VITE_DEV_PORT || 5173;
    win.loadURL(`http://localhost:${port}`);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  startFileServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (folderWatcher) folderWatcher.close();
  if (fileServer) fileServer.close();
  if (natResult?.upnpControlUrl && natResult?.externalPort) {
    releaseUpnpMapping(natResult.upnpControlUrl, natResult.externalPort).catch(() => {});
  }
  if (process.platform !== 'darwin') app.quit();
});
