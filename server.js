const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
// Plain HTTP on localhost only, for quick local testing (Chrome treats
// http://localhost as a secure context, so getUserMedia still works there).
// Real LAN/phone use always needs the HTTPS port above. This one is
// controlled by PORT so it plays nicely with tools that inject that env var.
const PORT = process.env.PORT || 8081;

// The PIN stays stable across restarts (persisted to a local file) unless
// overridden by the PIN env var. This matters because the camera/controller
// pages remember an accepted PIN in localStorage and auto-connect with it —
// a bookmarked "Add to Home Screen" shortcut on the camera phone only stays
// hands-off if the PIN it remembers keeps being valid after the server
// restarts (e.g. the phone rebooting).
const PIN_FILE = path.join(__dirname, '.pin');
function getPin() {
  if (process.env.PIN) return process.env.PIN;
  try {
    const saved = fs.readFileSync(PIN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // no saved PIN yet
  }
  const pin = crypto.randomBytes(3).toString('hex'); // e.g. "a1b2c3"
  try {
    fs.writeFileSync(PIN_FILE, pin);
  } catch (err) {
    console.warn('Could not persist PIN to disk, it will change on next restart:', err.message);
  }
  return pin;
}
const PIN = getPin();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const publicDir = path.join(__dirname, 'public');

function requestHandler(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/control.html';
  const filePath = path.join(publicDir, reqPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    // No caching: these files change during development, and a stale cached
    // copy of camera.js/control.js silently running old logic after a reload
    // is a confusing bug to chase.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  },
  requestHandler
);

const httpServer = http.createServer(requestHandler);

const wss = new WebSocketServer({ noServer: true });
function handleUpgrade(req, socket, head) {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
server.on('upgrade', handleUpgrade);
httpServer.on('upgrade', handleUpgrade);

// v1: single pairing slot. One camera, one controller.
const peers = { camera: null, control: null };
const other = { camera: 'control', control: 'camera' };

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'https://localhost');
  const role = url.searchParams.get('role');
  const pin = url.searchParams.get('pin');

  if (pin !== PIN) {
    send(ws, { type: 'error', message: 'Invalid PIN' });
    ws.close();
    return;
  }
  if (role !== 'camera' && role !== 'control') {
    ws.close();
    return;
  }

  // A reconnect (WiFi blip, page reload) takes over the slot immediately
  // instead of being locked out until the old, likely-dead socket times out.
  if (peers[role]) {
    peers[role].close();
  }
  peers[role] = ws;
  ws.isAlive = true;
  console.log(`${role} connected`);

  const peer = peers[other[role]];
  if (peer) {
    send(ws, { type: 'peer-joined' });
    send(peer, { type: 'peer-joined' });
  }

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    console.log(`${role} disconnected`);
    if (peers[role] === ws) {
      peers[role] = null;
      send(peers[other[role]], { type: 'peer-left' });
    }
  });

  ws.on('message', (data) => {
    // Relay signaling messages (offer/answer/ice-candidate) to the other peer.
    const target = peers[other[role]];
    if (target) target.send(data.toString());
  });
});

// Heartbeat: detect and clean up connections that dropped without a clean
// close (WiFi cut, phone locked) so the other side gets 'peer-left' promptly
// instead of waiting on a TCP timeout that can take minutes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(HTTPS_PORT, () => {
  const nets = require('os').networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log(`\nRemote Camera server running (HTTPS on ${HTTPS_PORT}, HTTP on ${PORT} for localhost testing)`);
  console.log(`PIN: ${PIN}\n`);
  console.log('On the broken-screen phone (camera):');
  addrs.forEach((a) => console.log(`  https://${a}:${HTTPS_PORT}/camera.html?pin=${PIN}`));
  console.log('\nOn the controller (PC / other phone):');
  addrs.forEach((a) => console.log(`  https://${a}:${HTTPS_PORT}/control.html?pin=${PIN}`));
  console.log('\n(Both devices must be on the same network. Accept the self-signed certificate warning on first visit.)');
  console.log(`\nLocal testing only (same machine): http://localhost:${PORT}/camera.html?pin=${PIN}  and  /control.html\n`);
});

// Bound to loopback only: this port is not a secure context for any other
// host, so getUserMedia() would silently be undefined there anyway. Binding
// it to 127.0.0.1 turns that into an obvious "connection refused" instead.
httpServer.listen(PORT, '127.0.0.1');
