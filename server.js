// server.js (backend)
// Polyfills & imports
global.WebSocket = require('ws');
global.fetch = require('node-fetch');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

const app = express();
const server = http.createServer(app);

// Allow socket.io from any origin (adjust in production)
const io = new Server(server, {
  cors: { origin: ["*"] }
});

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// Map sessionId -> { sock, saveCreds, folder, meta }
const sessions = {};

// Ensure base sessions folder exists
const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// Returns next auth_infoN folder name (auth_info1, auth_info2...)
function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => {
    const m = n.match(/auth_info(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

async function startBaileysForSession(sessionId, folderName, socket) {
  if (sessions[sessionId]) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);

  // useMultiFileAuthState will create files in dir
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`Using WA version v${version.join('.')}, session folder=${dir}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        socket.emit('qr', { sessionId, qrDataUrl: dataUrl });
      } catch (e) {
        socket.emit('qr', { sessionId, qrString: qr });
      }
    }

    if (connection === 'open') {
      console.log('Connected session', sessionId);
      socket.emit('connected', { sessionId, folderName });
      // save a small meta file
      try {
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now() }, null, 2));
      } catch (e) {}
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error || {}).output?.statusCode || null;
      console.log('Connection closed', sessionId, code);
      socket.emit('disconnected', { sessionId, reason: code });
      // If logged out, cleanup in-memory map (files remain)
      if (code === DisconnectReason.loggedOut) {
        try { sock.end(); } catch (e) {}
        delete sessions[sessionId];
      }
    }
  });

  sock.ev.on('messages.upsert', m => {
    // Optional: forward messages to frontend if needed
    // console.log('message', sessionId, m.type);
  });

  sessions[sessionId] = { sock, saveCreds, folderName, dir };
  return sessions[sessionId];
}

// Socket.io handlers
io.on('connection', (socket) => {
  console.log('Web client connected', socket.id);

  // Create a new session request from frontend
  // payload: { profile: 'adam'|'tf', name, phone }
  socket.on('create_session', async (payload) => {
    try {
      const profile = (payload && payload.profile) ? String(payload.profile) : 'unknown';
      const name = (payload && payload.name) ? String(payload.name) : '';
      const phone = (payload && payload.phone) ? String(payload.phone) : '';

      // Choose next folder name
      const folderName = nextAuthFolder(); // auth_info1, auth_info2...
      const sessionId = uuidv4();

      // start Baileys for this session and link events to this socket
      await startBaileysForSession(sessionId, folderName, socket);

      // Save small metadata for reference
      const meta = { sessionId, folderName, profile, name, phone, createdAt: Date.now() };
      try {
        fs.writeFileSync(path.join(SESSIONS_BASE, folderName, 'meta.json'), JSON.stringify(meta, null, 2));
      } catch (e) {
        // ignore write errors
      }

      socket.emit('session_created', { sessionId, folderName });
    } catch (err) {
      console.error('create_session error', err);
      socket.emit('error', { message: 'Failed to create session', detail: err.message });
    }
  });

  socket.on('close_session', ({ sessionId }) => {
    const s = sessions[sessionId];
    if (s) {
      try { s.sock.end(); } catch (e) {}
      delete sessions[sessionId];
      socket.emit('session_closed', { sessionId });
    } else {
      socket.emit('error', { message: 'Session not found' });
    }
  });

  socket.on('list_sessions', () => {
    const arr = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info')).map(n => {
      let meta = {};
      const metaPath = path.join(SESSIONS_BASE, n, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
      }
      return { folder: n, meta };
    });
    socket.emit('sessions_list', arr);
  });

  socket.on('disconnect', () => {
    console.log('Web client disconnected', socket.id);
  });
});

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT} (port ${PORT})`);
});
