/* ============================================================
   YowisBenxDeveloper — Panel Backend v3.0
   ============================================================ */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

/* ---------- CONFIG ---------- */
const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || 'YowisBen';
const PANEL_PASS = process.env.PANEL_PASS || 'YowisBen321';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOT_DIR = path.join(DATA_DIR, 'bot');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MEM_LIMIT = (parseInt(process.env.MEM_LIMIT_MB) || 1024) * 1048576;

fs.mkdirSync(BOT_DIR, { recursive: true });

const DEFAULT_CONFIG = {
  serverName: 'YowisBenxDeveloper',
  description: 'YowisBenx Bot Server',
  startup: 'node index.js',
  autoInstall: '1',
  dockerImage: 'Node 20 LTS + Vips/FFmpeg',
  var1: 'npm install --production',
  var2: 'node index.js'
};
function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
let config = loadConfig();
const saveConfig = c => (fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)), c);

let tokens = {};
let botProc = null;
let startedAt = null;
let consoleBuf = [];
const MAX_BUF = 1000;

/* ---------- APP ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 200e6 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- CONSOLE LOG ---------- */
function clog(type, text) {
  const line = { type, text: String(text), time: Date.now() };
  consoleBuf.push(line);
  if (consoleBuf.length > MAX_BUF) consoleBuf.shift();
  io.emit('console', line);
}

/* ---------- AUTH ---------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === PANEL_USER && password === PANEL_PASS) {
    const token = crypto.randomBytes(24).toString('hex');
    tokens[token] = Date.now();
    clog('info', `User "${username}" logged in`);
    return res.json({ ok: true, token, serverName: config.serverName });
  }
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

app.use('/api', (req, res, next) => {
  const t = req.headers['x-auth'];
  if (t && tokens[t]) return next();
  res.status(401).json({ ok: false, error: 'Unauthorized' });
});

/* ---------- SAFE PATH ---------- */
function safePath(p = '/') {
  const full = path.resolve(BOT_DIR, '.' + path.sep + String(p));
  if (full !== BOT_DIR && !full.startsWith(BOT_DIR + path.sep)) throw new Error('Forbidden path');
  return full;
}

/* ---------- REAL-TIME FILE WATCHER ---------- */
let watchDebounce = null;
try {
  fs.watch(BOT_DIR, { recursive: true }, (event, filename) => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      io.emit('files:changed', { event, filename: filename || null });
    }, 400);
  });
  clog('success', 'Real-time file watcher active');
} catch (e) {
  clog('warn', 'File watcher unavailable: ' + e.message);
}

/* ---------- FILE API ---------- */
app.get('/api/files', (req, res) => {
  try {
    const rel = req.query.path || '/';
    const dir = safePath(rel);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
      let size = 0, mtime = 0, mode = '0644';
      try {
        const st = fs.statSync(path.join(dir, e.name));
        size = st.size; mtime = st.mtimeMs;
        mode = (st.mode & 0o777).toString(8).padStart(4, '0');
      } catch {}
      return { name: e.name, dir: e.isDirectory(), size, mtime, mode };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ ok: true, path: rel, entries });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/file/read', (req, res) => {
  try {
    res.json({ ok: true, content: fs.readFileSync(safePath(req.query.path), 'utf8') });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/file/write', (req, res) => {
  try {
    const full = safePath(req.body.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.body.content ?? '');
    clog('success', `File saved: ${req.body.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* RENAME + MOVE (rename lintas folder = move) */
app.post('/api/file/rename', (req, res) => {
  try {
    fs.renameSync(safePath(req.body.from), safePath(req.body.to));
    clog('info', `Moved/Renamed: ${req.body.from} → ${req.body.to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* COPY */
app.post('/api/file/copy', (req, res) => {
  try {
    fs.cpSync(safePath(req.body.from), safePath(req.body.to), { recursive: true });
    clog('success', `Copied: ${req.body.from} → ${req.body.to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* PERMISSIONS (chmod) */
app.post('/api/file/chmod', (req, res) => {
  try {
    fs.chmodSync(safePath(req.body.path), parseInt(req.body.mode || '0644', 8));
    clog('success', `Permissions changed: ${req.body.path} → ${req.body.mode}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* UNARCHIVE (.zip / .tar / .tar.gz) */
app.post('/api/file/unarchive', (req, res) => {
  try {
    const full = safePath(req.body.path);
    const dir = path.dirname(full);
    const n = full.toLowerCase();
    let cmd;
    if (n.endsWith('.zip')) cmd = `unzip -o "${full}" -d "${dir}"`;
    else if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) cmd = `tar -xzf "${full}" -C "${dir}"`;
    else if (n.endsWith('.tar')) cmd = `tar -xf "${full}" -C "${dir}"`;
    else throw new Error('Format tidak didukung (.zip / .tar / .tar.gz saja)');
    execSync(cmd, { timeout: 120000 });
    clog('success', `Unarchived: ${req.body.path}`);
    io.emit('files:changed', { event: 'unarchive', filename: req.body.path });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* DOWNLOAD (folder otomatis di-zip) */
app.get('/api/file/download', (req, res) => {
  try {
    const full = safePath(req.query.path);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const tmp = path.join(os.tmpdir(), 'dl_' + Date.now() + '.zip');
      execSync(`cd "${path.dirname(full)}" && zip -r "${tmp}" "${path.basename(full)}"`, { timeout: 120000 });
      res.download(tmp, path.basename(full) + '.zip', () => { try { fs.rmSync(tmp, { force: true }); } catch {} });
    } else {
      res.download(full);
    }
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/mkdir', (req, res) => {
  try {
    fs.mkdirSync(safePath(req.body.path), { recursive: true });
    clog('success', `Directory created: ${req.body.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/file/delete', (req, res) => {
  try {
    const full = safePath(req.body.path);
    if (full === BOT_DIR) throw new Error('Tidak bisa hapus folder root');
    fs.rmSync(full, { recursive: true, force: true });
    clog('warn', `Deleted: ${req.body.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- UPLOAD ---------- */
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const dir = safePath(req.body.path || '/');
    const results = [];
    (req.files || []).forEach(f => {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      fs.writeFileSync(path.join(dir, name), f.buffer);
      results.push({ name, size: f.size });
      clog('success', `Uploaded: ${name} (${(f.size / 1024).toFixed(1)} KB)`);
    });
    io.emit('files:changed', { event: 'upload', filename: results.map(r => r.name).join(', ') });
    res.json({ ok: true, count: results.length });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- CONFIG API ---------- */
app.get('/api/config', (req, res) => res.json({ ok: true, config }));
app.post('/api/config', (req, res) => {
  config = saveConfig({ ...config, ...req.body });
  clog('info', 'Configuration updated');
  io.emit('config', config);
  res.json({ ok: true, config });
});

/* ---------- POWER CONTROL ---------- */
function spawnBot() {
  if (botProc) return clog('error', 'Server is already running.');
  const entry = ['index.js', 'bot.js', 'main.js'].find(f => fs.existsSync(path.join(BOT_DIR, f)));
  if (!entry) {
    clog('error', 'Tidak ada entry file (index.js/bot.js/main.js). Upload script bot dulu di tab Files!');
    return;
  }

  const doStart = () => {
    clog('info', `container@yowisbenx~ ${config.startup}`);
    clog('info', 'Server marked as starting...');
    const child = spawn('bash', ['-lc', config.startup], {
      cwd: BOT_DIR, detached: true,
      env: { ...process.env, HOME: BOT_DIR, TERM: 'xterm-256color' }
    });
    botProc = child;
    startedAt = Date.now();
    io.emit('power:state', { running: true, startedAt });

    const pipe = (stream, type) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', d => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(l => l.length && clog(type, l));
      });
      stream.on('end', () => buf.length && clog(type, buf));
    };
    pipe(child.stdout, 'normal');
    pipe(child.stderr, 'error');

    child.on('exit', code => {
      clog('warn', `Server marked as offline — exit code ${code ?? 'killed'}`);
      botProc = null; startedAt = null;
      io.emit('power:state', { running: false });
    });
    clog('success', 'Server started successfully');
  };

  const hasPkg = fs.existsSync(path.join(BOT_DIR, 'package.json'));
  const hasMods = fs.existsSync(path.join(BOT_DIR, 'node_modules'));
  if (config.autoInstall === '1' && hasPkg && !hasMods) {
    clog('info', '📦 Installing dependencies (npm install)... mohon tunggu');
    const inst = spawn('bash', ['-lc', config.var1 || 'npm install --production'], { cwd: BOT_DIR });
    inst.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => clog('normal', l)));
    inst.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => clog('normal', l)));
    inst.on('exit', code => {
      if (code === 0) clog('success', '✓ Dependencies installed');
      else clog('error', `npm install exit ${code} — mencoba start tetap`);
      doStart();
    });
  } else doStart();
}

function stopBot(force = false) {
  if (!botProc) return clog('warn', 'Server is not running.');
  clog('warn', force ? 'KILLING server (SIGKILL)...' : 'Stopping server (SIGTERM)...');
  try { process.kill(-botProc.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  if (!force) setTimeout(() => {
    if (botProc) {
      clog('warn', 'Force killing (SIGKILL)...');
      try { process.kill(-botProc.pid, 'SIGKILL'); } catch {}
    }
  }, 4000);
}

/* ---------- SOCKET.IO ---------- */
io.on('connection', sock => {
  let authed = false;

  sock.on('auth', token => {
    if (!tokens[token]) return sock.disconnect();
    authed = true;
    sock.emit('console:history', consoleBuf);
    sock.emit('power:state', { running: !!botProc, startedAt });
    sock.emit('config', config);
  });

  sock.on('power', action => {
    if (!authed) return;
    if (action === 'start') spawnBot();
    else if (action === 'stop') stopBot();
    else if (action === 'kill') stopBot(true);
    else if (action === 'restart') {
      clog('warn', 'Restarting server...');
      stopBot();
      setTimeout(() => { if (!botProc) spawnBot(); }, 5000);
    }
  });

  sock.on('command', cmd => {
    if (!authed || !cmd) return;
    clog('cmd', cmd);
    if (cmd === 'clear') { consoleBuf = []; io.emit('console:history', consoleBuf); return; }
    runOnce(cmd);
  });

  function runOnce(cmd) {
    const p = spawn('bash', ['-lc', cmd], { cwd: BOT_DIR });
    p.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => clog('normal', l)));
    p.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => clog('error', l)));
    p.on('exit', c => clog('info', `command finished (${c})`));
  }
});

/* ---------- LIVE STATS ---------- */
let lastCpu = null, lastNet = null, diskCache = '0 B', lastDisk = 0;
const fmtB = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB'
  : b < 1073741824 ? (b/1048576).toFixed(1) + ' MB' : (b/1073741824).toFixed(2) + ' GB';

function walkSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) total += walkSize(f);
      else { try { total += fs.statSync(f).size; } catch {} }
    }
  } catch {}
  return total;
}

function readPidStats(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    let rssKb = 0;
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    if (m) rssKb = +m[1];
    return { cpuTicks: +stat[13] + +stat[14], rssKb };
  } catch { return null; }
}
function readNet() {
  try {
    let rx = 0, tx = 0;
    fs.readFileSync('/proc/net/dev', 'utf8').split('\n').forEach(l => {
      if (l.includes(':') && !l.includes('lo:')) {
        const f = l.split(':')[1].trim().split(/\s+/);
        rx += +f[0]; tx += +f[8];
      }
    });
    return { rx, tx };
  } catch { return null; }
}

setInterval(() => {
  const now = Date.now();
  let cpu = 0, mem = 0;
  if (botProc) {
    const s = readPidStats(botProc.pid);
    if (s) {
      if (lastCpu) {
        const dt = Math.max(0.5, (now - lastCpu.t) / 1000);
        cpu = Math.max(0, Math.min(400, ((s.cpuTicks - lastCpu.ticks) / dt / os.cpus().length) * 100));
      }
      lastCpu = { ticks: s.cpuTicks, t: now };
      mem = s.rssKb * 1024;
    } else {
      cpu = +(os.loadavg()[0] * 100 / os.cpus().length).toFixed(1);
    }
  } else lastCpu = null;

  const net = readNet();
  let netIn = 0, netOut = 0;
  if (net) {
    if (lastNet) { netIn = Math.max(0, net.rx - lastNet.rx); netOut = Math.max(0, net.tx - lastNet.tx); }
    lastNet = net;
  }

  if (now - lastDisk > 30000) {
    lastDisk = now;
    diskCache = fmtB(walkSize(BOT_DIR));
  }

  io.emit('stats', {
    running: !!botProc,
    uptime: startedAt ? Math.floor((now - startedAt) / 1000) : 0,
    cpu: +cpu.toFixed(1),
    mem, memLimit: MEM_LIMIT,
    disk: diskCache,
    netIn, netOut,
    address: `YowisBenx:${PORT}`
  });
}, 2000);

server.listen(PORT, () => {
  console.log('=========================================');
  console.log('  YowisBenxDeveloper Panel v3.0');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  Login: ${PANEL_USER} / ${PANEL_PASS}`);
  console.log('=========================================');
});
