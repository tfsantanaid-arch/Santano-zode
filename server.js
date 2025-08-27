global.WebSocket = require('ws');
global.fetch = require('node-fetch');

// Imports
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

// Allowed origin (set via env on Render if needed)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://adam-d-h7-q8qo.onrender.com';

const io = new Server(server, {
  cors: { origin: [ALLOWED_ORIGIN], methods: ['GET','POST'] },
  pingInterval: 25000,
  pingTimeout: 120000
});

// static frontend folder
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));

// sessions base dir
const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// Utils
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => {
    const m = n.match(/auth_info(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

// Menu text + image (exact as requested)
const MENU_TEXT = `Owner: Santana
Version: 1.0.0
Type: Node.js
_____________________________
*○ Menu*
*○ Tagall*
*● Hidetag [text]*
*○ Del    (reply)*
*● Kickall*
*○ Qr [text]*
*● Kick @number | reply*
*○ Add 509XXXXXXXX | reply*
*● Promote @number | reply*
*○ Delmote @number | reply*
*● Ferme*
*○ Ouvert*
*● Bienvenue | .bienvenue off*

> © D'H7 : Tergene`;

// Image that must be sent with every message except hidetag
const IMAGE_URL = 'https://res.cloudinary.com/dckwrqrur/image/upload/v1756264264/tf-stream-url/IMG-20250826-WA0000_ymn2wa.jpg';

// in-memory sessions map
const sessions = {};

/**
 * startBaileysForSession
 * - sessionId: uuid (in-memory key)
 * - folderName: auth_info folder name
 * - socket: socket.io client
 */
async function startBaileysForSession(sessionId, folderName, socket, opts = { attempt: 0 }) {
  if (sessions[sessionId] && sessions[sessionId].sock) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // load auth state
  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(dir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error(`[${sessionId}] useMultiFileAuthState failed`, err);
    socket.emit('error', { message: 'Failed to load auth state', detail: String(err) });
    throw err;
  }

  // fetch WA version (best-effort)
  let version = undefined;
  try {
    const res = await fetchLatestBaileysVersion();
    if (res && res.version) version = res.version;
  } catch (err) {
    console.warn(`[${sessionId}] fetchLatestBaileysVersion failed — proceeding without explicit version`);
  }

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  // per-session state
  const sessionObj = {
    sock,
    saveCreds,
    folderName,
    dir,
    restarting: false,
    cachedImageBuffer: null,
    invisibleMode: {}, // map jid -> intervalId
    bienvenueEnabled: {} // map jid -> boolean
  };
  sessions[sessionId] = sessionObj;

  // persist creds
  sock.ev.on('creds.update', saveCreds);

  // helper: fetch/cached image buffer
  async function fetchImageBuffer() {
    if (sessionObj.cachedImageBuffer) return sessionObj.cachedImageBuffer;
    try {
      const res = await fetch(IMAGE_URL);
      if (!res.ok) throw new Error('fetch status ' + res.status);
      const ab = await res.arrayBuffer();
      sessionObj.cachedImageBuffer = Buffer.from(ab);
      return sessionObj.cachedImageBuffer;
    } catch (e) {
      // If buffer fetch fails, we will fallback to sending by URL later.
      return null;
    }
  }

  // helper: send text + image (tries buffer then URL then fallback to text)
  // options.skipImage => send text-only (used for hidetag)
  async function sendWithImage(jid, content, options = {}) {
    const text = (typeof content === 'string') ? content : (content.text || '');
    const mentions = (typeof content === 'object' && content.mentions) ? content.mentions : undefined;
    const quoted = (typeof content === 'object' && content.quoted) ? content.quoted : undefined;

    if (options.skipImage) {
      const msg = { text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return sock.sendMessage(jid, msg);
    }

    // Try cached buffer first
    try {
      const buf = await fetchImageBuffer();
      if (buf) {
        const msg = { image: buf, caption: text };
        if (mentions) msg.mentions = mentions;
        if (quoted) msg.quoted = quoted;
        return await sock.sendMessage(jid, msg);
      }
    } catch (err) {
      console.warn(`[${sessionId}] image buffer send failed:`, err);
    }

    // If buffer not available, try sending by URL
    try {
      const msg = { image: { url: IMAGE_URL }, caption: text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return await sock.sendMessage(jid, msg);
    } catch (err) {
      console.warn(`[${sessionId}] image url send failed:`, err);
    }

    // final fallback: text-only
    const msg = { text };
    if (mentions) msg.mentions = mentions;
    if (quoted) msg.quoted = quoted;
    return sock.sendMessage(jid, msg);
  }

  // ---- helpers for group-targeted commands ----
  async function isGroupAdmin(jid, participantId) {
    try {
      const meta = await sock.groupMetadata(jid);
      const p = meta.participants.find(x => x.id === participantId);
      return !!(p && (p.admin || p.admin === 'superadmin'));
    } catch (e) {
      return false;
    }
  }

  function resolveTargetIds({ jid, m, args }) {
    const ids = [];
    const ctx = m.extendedTextMessage?.contextInfo || {};
    if (ctx.mentionedJid && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
      return ctx.mentionedJid;
    }
    if (ctx.participant) ids.push(ctx.participant);
    if (args && args.length) {
      for (const a of args) {
        // accept +509xxxxxxxx or 509xxxxxxxx or raw jid
        if (a.includes('@')) { ids.push(a); continue; }
        const cleaned = a.replace(/[^0-9+]/g, '');
        if (!cleaned) continue;
        const noPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
        ids.push(`${noPlus}@s.whatsapp.net`);
      }
    }
    return Array.from(new Set(ids));
  }
  // ---- end helpers ----

  // message handler (commands) — implemented to match the exact Adam_D'H7 behavior (plus added commands)
  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || [];
      if (!messages.length) return;
      const msg = messages[0];
      if (!msg || !msg.message) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid && jid.endsWith && jid.endsWith('@g.us');
      const fromMe = !!msg.key.fromMe;

      // ignore status broadcasts
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      // extract raw text
      let raw = '';
      const m = msg.message;
      if (m.conversation) raw = m.conversation;
      else if (m.extendedTextMessage?.text) raw = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) raw = m.imageMessage.caption;
      else if (m.videoMessage?.caption) raw = m.videoMessage.caption;
      else if (m.documentMessage?.caption) raw = m.documentMessage.caption;
      else raw = '';

      const textRaw = (raw || '').toString().trim();
      const withoutDot = textRaw.startsWith('.') ? textRaw.slice(1) : textRaw;
      const parts = withoutDot.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || '').toLowerCase();
      const args = parts.slice(1);
      const argText = args.join(' ').trim();

      // debug
      console.log(`[${sessionId}] MSG from=${jid} id=${msg.key.id} fm=${fromMe} cmd=${cmd} text="${textRaw}"`);

      // If invisible-mode active in group: send image messages (bot requirement)
      if (isGroup && sessionObj.invisibleMode[jid]) {
        try { await sendWithImage(jid, 'ㅤ   '); } catch (e) {}
        return;
      }

      switch (cmd) {
        case 'd':
        case 'menu':
          await sendWithImage(jid, MENU_TEXT);
          break;

        case 'tg':
        case 'tagall':
          if (!isGroup) {
            await sendWithImage(jid, "*Adam_D'H7*\n Petit con *Tagall* est que pour Groupe");
            break;
          }
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            const list = ids.map((id,i) => `${i===0 ? '●' : '○'}@${id.split('@')[0]}`).join('\n');
            const out = `*Santana*\n${list}\n>》》 》》》 》》D'H7:Tergene`;
            await sendWithImage(jid, { text: out, mentions: ids });
          } catch (e) {
            console.error(`[${sessionId}] tagall error`, e);
            await sendWithImage(jid, "*Adam_D'H7*\nErr: pa kapab jwenn metadata gwoup la.");
          }
          break;

        case 'tm':
        case 'hidetag':
          // For .tm /.hidetag send text-only (no image) with mentions
          if (!isGroup) {
            await sock.sendMessage(jid, { text: "*Adam_D'H7*\nHidetag est un commandes fait pour groupes" });
            break;
          }
          if (!argText) {
            await sock.sendMessage(jid, { text: "*Adam_D'H7*\n envoie `hidetag [tèks]`" });
            break;
          }
          try {
            const meta2 = await sock.groupMetadata(jid);
            const ids2 = meta2.participants.map(p => p.id);
            // send text-only with mentions — hidetag must not include the image
            await sock.sendMessage(jid, { text: argText, mentions: ids2 });
          } catch (e) {
            console.error(`[${sessionId}] hidetag error`, e);
            await sock.sendMessage(jid, { text: "*Adam_D'H7*\nHidetag failed." });
          }
          break;

        case 'dh7':
          if (!isGroup) {
            await sendWithImage(jid, "*Adam_D'H7*\nMode Envizib spam se pou gwoup sèlman.");
            break;
          }
          if (sessionObj.invisibleMode[jid]) {
            await sendWithImage(jid, "*Adam_D'H7*\nMode envizib deja aktive.");
            break;
          }
          // start interval that sends image messages every second (as requested)
          sessionObj.invisibleMode[jid] = setInterval(() => {
            sendWithImage(jid, 'ㅤ   ').catch(()=>{});
          }, 1000);
          await sendWithImage(jid, "*Adam_D'H7*\nMode envizib aktive: ap spam mesaj vid.");
          break;

        case 'del':
          {
            const ctx = m.extendedTextMessage?.contextInfo;
            if (ctx?.stanzaId) {
              const quoted = {
                remoteJid: jid,
                fromMe: false,
                id: ctx.stanzaId,
                participant: ctx.participant
              };
              try {
                await sock.sendMessage(jid, { delete: quoted });
              } catch (e) {
                console.error(`[${sessionId}] sip delete error`, e);
                await sendWithImage(jid, "*Santana*\n ne peut pas effacer ce message");
              }
            } else {
              await sendWithImage(jid, "*Santana*\n Répond un message avec .del pour le supprimer");
            }
          }
          break;

        case 'kickall':
          if (!isGroup) {
            await sendWithImage(jid, "*Santana*\n Kickall n'est que pour groupe");
            break;
          }
          try {
            const meta3 = await sock.groupMetadata(jid);
            const admins = meta3.participants.filter(p => p.admin || p.admin === 'superadmin').map(p => p.id);
            // determine sender id (works for groups where key.participant exists)
            const sender = msg.key.participant || msg.key.remoteJid;
            if (!admins.includes(sender)) {
              await sendWithImage(jid, "*Santana*\n t'es même pas admin");
              break;
            }
            for (const p of meta3.participants) {
              if (!admins.includes(p.id)) {
                try {
                  await sock.groupParticipantsUpdate(jid, [p.id], 'remove');
                  await sleep(3000);
                } catch (e) {
                  console.error(`[${sessionId}] kick error for ${p.id}`, e);
                }
              }
            }
            await sock.groupUpdateSubject(jid, "Adam_D'H7");
          } catch (e) {
            console.error(`[${sessionId}] sipyo error`, e);
            await sendWithImage(jid, "*Adam_D'H7*\nSipyo echwe: " + (e?.message || String(e)));
          }
          break;

        case 'qr':
          if (!argText) {
            await sendWithImage(jid, "*Adam_D'H7*\n`.qr [tèks]`");
            break;
          }
          try {
            const buf = await QRCode.toBuffer(argText);
            await sock.sendMessage(jid, { image: buf, caption: `*Adam_D'H7*\n ${argText}` });
          } catch (e) {
            console.error(`[${sessionId}] qr gen error`, e);
            await sendWithImage(jid, "*Adam_D'H7*\nPa kapab jenere QR.");
          }
          break;

        case 'img':
        case 'image':
          try {
            const buf = await fetchImageBuffer();
            if (buf) {
              await sock.sendMessage(jid, { image: buf, caption: "*Adam_D'H7*\nMen imaj la." });
            } else {
              // fallback to URL send via sendWithImage (it will try URL)
              await sendWithImage(jid, "*Adam_D'H7*\nMen imaj la.");
            }
          } catch (err) {
            console.error(`[${sessionId}] image command failed`, err);
            try {
              await sendWithImage(jid, "*Adam_D'H7*\nMen imaj la. (fallback url)");
            } catch(e){
              console.error(`[${sessionId}] fallback image send failed`, e);
            }
          }
          break;

        //
        // === NEW ADDED COMMANDS (kick, add, promote, delmote, ferme, ouvert, bienvenue) ===
        //
        case 'kick': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\nKick est que pour groupes"); break; }
          const senderKick = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderKick))) { await sendWithImage(jid, "*Adam_D'H7*\nOu pa gen dwa admin pou itilize kick."); break; }
          const targetsKick = resolveTargetIds({ jid, m, args });
          if (!targetsKick.length) { await sendWithImage(jid, "*Santana*\n Reply ou tag l'utilisateur que tu kick avek kick eg kick @user"); break; }
          for (const t of targetsKick) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sleep(500); } catch (e) { console.error(`[${sessionId}] kick error ${t}`, e); await sendWithImage(jid, `*Adam_D'H7*\nPa kapab kick ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'add': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\n Add c'est fait rien que pour les groupes"); break; }
          const senderAdd = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderAdd))) { await sendWithImage(jid, "*Santana*\nTu n'est pas un admin"); break; }
          const targetsAdd = resolveTargetIds({ jid, m, args });
          if (!targetsAdd.length) { await sendWithImage(jid, "*Santana*\n les chiffres doit être collé eg +50935492574"); break; }
          for (const t of targetsAdd) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'add'); await sleep(800); } catch (e) { console.error(`[${sessionId}] add error ${t}`, e); await sendWithImage(jid, `*Adam_D'H7*\nPa kapab ajoute ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'promote': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\nPromote c'est un commandes pour groupes"); break; }
          const senderProm = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderProm))) { await sendWithImage(jid, "*Santana*\nTu n'est pas admin"); break; }
          const targetsProm = resolveTargetIds({ jid, m, args });
          if (!targetsProm.length) { await sendWithImage(jid, "*Santana*\nReply ou tag l'utilisateur eg promote @user"); break; }
          for (const t of targetsProm) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'promote'); await sleep(500); } catch (e) { console.error(`[${sessionId}] promote error ${t}`, e); await sendWithImage(jid, `*Adam_D'H7*\nPa kapab promote ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'delmote':
        case 'demote': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\nDelmote c'est un commandes pour groupes"); break; }
          const senderDem = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderDem))) { await sendWithImage(jid, "*Adam_D'H7*\n t'es pas un admin."); break; }
          const targetsDem = resolveTargetIds({ jid, m, args });
          if (!targetsDem.length) { await sendWithImage(jid, "*Santana*\n reply ou tag eg delmote @user"); break; }
          for (const t of targetsDem) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'demote'); await sleep(500); } catch (e) { console.error(`[${sessionId}] delmote error ${t}`, e); await sendWithImage(jid, `*Adam_D'H7*\nPa kapab delmote ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'ferme': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\n rien que pour groupes"); break; }
          const senderFerme = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderFerme))) { await sendWithImage(jid, "*Santana*\n t'es pas un admin"); break; }
          try { await sock.groupSettingUpdate(jid, 'announcement'); await sendWithImage(jid, "*Adam_D'H7*\n c'est fermé \"admins only\""); } catch(e){ console.error(`[${sessionId}] ferme error`, e); await sendWithImage(jid, "*Adam_D'H7*\nPa kapab mete gwoup la nan fermét."); }
          break;
        }

        case 'ouvert': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\nOuvert est que pour groupe"); break; }
          const senderOuv = msg.key.participant || msg.key.remoteJid;
          if (!(await isGroupAdmin(jid, senderOuv))) { await sendWithImage(jid, "*Adam_D'H7*\nOu pa gen dwa admin pou fè sa."); break; }
          try { await sock.groupSettingUpdate(jid, 'not_announcement'); await sendWithImage(jid, "*Adam_D'H7*\n c'est ouvert"); } catch(e){ console.error(`[${sessionId}] ouvert error`, e); await sendWithImage(jid, "*Adam_D'H7*\nPa kapab louvri gwoup la."); }
          break;
        }

        case 'bienvenue': {
          if (!isGroup) { await sendWithImage(jid, "*Santana*\nBienvenue c'est un commands de groupes"); break; }
          // argText === 'off' => disable
          sessionObj.bienvenueEnabled[jid] = !(argText && argText.toLowerCase() === 'off');
          await sendWithImage(jid, `*Santana*\n Bienvenue: ${sessionObj.bienvenueEnabled[jid] ? 'ON' : 'OFF'}`);
          break;
        }

        // === end added commands ===

        default:
          // no command — ignore
          break;
      }

    } catch (err) {
      console.error('messages.upsert handler error', err);
    }
  });

  // participants / bienvenue handler (sends welcome if enabled)
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const gid = update.id || update.jid || update.groupId;
      if (!gid) return;
      if (!sessionObj.bienvenueEnabled[gid]) return;
      const meta = await sock.groupMetadata(gid);
      const groupName = meta.subject || '';
      for (const p of (update.participants || [])) {
        const userJid = typeof p === 'string' ? p : p?.id;
        if (!userJid) continue;
        const txt = `Bienvenue a toi @${userJid.split('@')[0]} dans ${groupName}`;
        // sendWithImage will fallback to text if image fetch fails
        await sendWithImage(gid, { text: txt, mentions: [userJid] });
      }
    } catch (e) { console.error('bienvenue error', e); }
  });

  // connection lifecycle
  sock.ev.on('connection.update', async (update) => {
    try {
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
        console.log(`[${sessionId}] Connected (folder=${folderName})`);
        socket.emit('connected', { sessionId, folderName });
        try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now() }, null, 2)); } catch(e){}
        if (sessions[sessionId]) sessions[sessionId].restarting = false;
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error || {}).output?.statusCode || null;
        console.log(`[${sessionId}] Connection closed, code=${code}`);
        socket.emit('disconnected', { sessionId, reason: code });

        // if logged out, cleanup
        if (code === DisconnectReason.loggedOut) {
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          return;
        }

        // restart required (515) or restartRequired enum
        if (code === DisconnectReason.restartRequired || code === 515) {
          console.log(`[${sessionId}] restart required (code ${code}). Attempting re-init.`);
          if (sessions[sessionId]) sessions[sessionId].restarting = true;
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];

          const attempt = (opts && opts.attempt) ? opts.attempt : 0;
          const delay = Math.min(30000, 2000 + attempt * 2000);
          setTimeout(() => {
            startBaileysForSession(sessionId, folderName, socket, { attempt: attempt + 1 })
              .then(() => socket.emit('restarted', { sessionId, folderName }))
              .catch(err => {
                console.error(`[${sessionId}] restart failed`, err);
                socket.emit('error', { message: 'Restart failed', detail: String(err) });
              });
          }, delay);
          return;
        }

        // other disconnects — try a single reconnect
        try { sock.end(); } catch(e){}
        delete sessions[sessionId];
        setTimeout(() => {
          startBaileysForSession(sessionId, folderName, socket, { attempt: 0 })
            .then(() => socket.emit('reconnected', { sessionId, folderName }))
            .catch(err => {
              console.error(`[${sessionId}] reconnect failed`, err);
              socket.emit('error', { message: 'Reconnect failed', detail: String(err) });
            });
        }, 5000);
      }
    } catch (err) {
      console.error('connection.update handler error', err);
    }
  });

  return sessionObj;
}

// socket.io handlers for web UI
io.on('connection', (socket) => {
  console.log('Web client connected', socket.id);

  socket.on('create_session', async (payload) => {
    try {
      const profile = (payload && payload.profile) ? String(payload.profile) : 'unknown';
      const name = (payload && payload.name) ? String(payload.name) : '';
      const phone = (payload && payload.phone) ? String(payload.phone) : '';

      const folderName = nextAuthFolder();
      const sessionId = uuidv4();

      const dir = path.join(SESSIONS_BASE, folderName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const meta = { sessionId, folderName, profile, name, phone, createdAt: Date.now() };
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch(e){}

      await startBaileysForSession(sessionId, folderName, socket);

      socket.emit('session_created', { sessionId, folderName });
    } catch (err) {
      console.error('create_session error', err);
      socket.emit('error', { message: 'Failed to create session', detail: String(err) });
    }
  });

  socket.on('list_sessions', () => {
    const arr = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info')).map(n => {
      let meta = {};
      const metaPath = path.join(SESSIONS_BASE, n, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
      }
      const inMem = Object.values(sessions).find(s => s.folderName === n);
      return { folder: n, meta, online: !!inMem, lastSeen: meta.connectedAt || null };
    });
    socket.emit('sessions_list', arr);
  });

  socket.on('destroy_session', (payload) => {
    try {
      if (!payload || !payload.folder) return socket.emit('error', { message: 'folder required' });
      const folder = payload.folder;
      const target = Object.entries(sessions).find(([k, v]) => v.folderName === folder);
      if (target) {
        const [sid, val] = target;
        try { val.sock.end(); } catch(e){}
        delete sessions[sid];
      }
      const full = path.join(SESSIONS_BASE, folder);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      socket.emit('session_destroyed', { folder });
    } catch (err) {
      console.error('destroy_session error', err);
      socket.emit('error', { message: 'Failed to destroy session', detail: String(err) });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Web client disconnected', socket.id, 'reason:', reason);
  });
});

// global error logging
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on http://localhost:${PORT} (port ${PORT})`));
