# Orchard: P2P File Sharing Application

Orchard is a private, self-hosted peer-to-peer file sharing application designed for trusted networks. It utilises an Electron/React desktop client for local file management and a Node.js/Socket.IO broker server for authentication, presence tracking, and network traversal.

## Core Architecture

* **The Broker (`packages/server`):** A Node.js backend using Express and Socket.IO for real-time presence, JWT-based authentication, and rate-limiting. Data is persisted via a Prisma SQLite database.
* **The Client (`packages/client`):** An Electron desktop application built with React and Vite. It runs a localised HTTP file server to serve shared files directly to authenticated peers.
* **NAT Traversal Ladder:** To facilitate direct P2P connections without relying on heavy cloud bandwidth, the client utilises a custom traversal engine (`nat-traversal.cjs`). It attempts UPnP (IGD) port mapping, falls back to NAT-PMP, and seamlessly downgrades to a broker-relayed connection if strict firewalls block direct traffic.
* **Zero-Trust File Indexing:** Shared file absolute paths are never broadcast to the network. The client generates opaque SHA-256 file references based on relative paths and file metadata to ensure host filesystem security.

## File Structure

```text
├── packages/
│   ├── client/                  # Electron desktop application & React UI
│   │   ├── src/                 # React components and configuration
│   │   ├── main.cjs             # Electron main process & local HTTP file server
│   │   └── nat-traversal.cjs    # UPnP & NAT-PMP port forwarding logic
│   ├── server/                  # Node.js broker server
│   │   ├── prisma/              # SQLite schema and migrations
│   │   └── src/                 # Socket.IO handlers, auth, and relay logic
│   └── shared/                  # Common protocol definitions and event constants
├── docker-compose.yml           # Broker deployment configuration
└── package.json                 # Monorepo workspace definitions

```

## Running Locally

Requires Node.js v18+.

```bash
# 1. Install workspace dependencies and run database migrations
npm run bootstrap

# 2. Start the local broker server
npm run start:server

# 3. Start the Electron client (run in a separate terminal)
npm run start:client

```
