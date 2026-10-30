// Shared by the production scripts (setup, update, rollback) and make_release.js.
// Module-specific settings are in deploy/module.json; this file is the same in every module.
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const readline = require('readline');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const DEPLOY_DIR = path.join(__dirname, '..');
const ROOT = path.join(DEPLOY_DIR, '..'); // the folder this copy of the module is in
const mod = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'module.json'), 'utf8'));

const envFile = (root) => path.join(root, mod.appDir, '.env');

function readEnv(root) {
  const file = envFile(root);
  if (!fs.existsSync(file)) return null;
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// Sets KEY=value in the .env (replacing the line, or adding it at the end).
function setEnvValue(root, key, value) {
  const file = envFile(root);
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\r\\n]*`, 'm');
  fs.writeFileSync(file, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\r\n${key}=${value}\r\n`);
}

const isPlaceholder = (v) => !v || /^<.*>$/.test(v);

function dbConfig(env) {
  const k = mod.dbEnv;
  return {
    host: env[k.host] || 'localhost',
    port: Number(env[k.port]) || 5432,
    database: env[k.name],
    user: env[k.user] || 'postgres',
    password: env[k.password],
  };
}

// A package of the module itself (pg, ...), loaded from its own node_modules.
const appRequire = (root, name) => createRequire(path.join(root, mod.appDir, 'package.json'))(name);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (exit ${r.status})`);
}

// The module's own database steps (migrate / seed), with its own .env, from its app folder.
function runScripts(root, list, label) {
  for (const s of list || []) {
    console.log(`--- ${label}: ${s.script}`);
    run(process.execPath, [s.script], { cwd: path.join(root, mod.appDir), env: { ...process.env, ...(s.env || {}) } });
  }
}

function pgTool(name) {
  const bin = process.env.PGBIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
  const exe = path.join(bin, `${name}.exe`);
  if (!fs.existsSync(exe)) throw new Error(`${exe} not found — set PGBIN to PostgreSQL's bin folder`);
  return exe;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

async function assertStopped(env) {
  const port = Number(env && env.PORT) || mod.port;
  if (await portInUse(port)) {
    throw new Error(`${mod.name} is running (port ${port}) — close the "${mod.title}" window first, then run this again.`);
  }
}

const backupRoot = () => process.env.BACKUP_ROOT || mod.backupRoot;

const readRelease = (dir) => {
  const f = path.join(dir, 'RELEASE.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

// Paths (forward slashes, relative to the module folder) that belong to the installation, not the release.
const isKept = (rel) => mod.keep.some((k) => rel === k || rel.startsWith(`${k}/`));

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Moves a folder; copies + deletes when it is on another drive.
function moveDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// One reader for all questions, so typed-ahead / piped answers are not lost between them.
// No more input (window closed, end of pipe) answers '' — i.e. "no".
let rl = null;
let closed = false;
const pending = [];
const waiting = [];
function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l.trim()); else pending.push(l.trim()); });
    rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
  }
  process.stdout.write(question);
  if (pending.length) return Promise.resolve(pending.shift());
  if (closed) return Promise.resolve('');
  return new Promise((resolve) => waiting.push(resolve));
}

// Runs main() and turns an error into a readable message + exit code 1 (the .bat shows it).
function main(fn) {
  fn()
    .then(() => { if (rl) rl.close(); })
    .catch((err) => {
      console.error(`\nFAILED: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  ROOT, mod, envFile, readEnv, setEnvValue, isPlaceholder, dbConfig, appRequire, run, runScripts,
  pgTool, portInUse, assertStopped, backupRoot, readRelease, isKept, copyFile, moveDir, stamp, sha256, ask, main,
};
