'use strict';
/**
 * Refresh the public quick (trycloudflare) tunnel and repoint the QR base URL.
 *
 * Quick-tunnel hostnames are random and die whenever cloudflared stops —
 * after any reboot, QR codes then scan to a dead host ("can't reach server").
 * Run this AFTER the server is up on :5000:
 *
 *     node scripts/refresh-tunnel.js
 *
 * It kills any running cloudflared, starts a fresh quick tunnel for
 * http://localhost:5000, waits for the new URL in its log, rewrites
 * BASE_URL in .env and both tunnel lines in .freebuff/netlify-deploy/_redirects,
 * and prints the new URL (restart the node server yourself afterwards so
 * qrService picks the new BASE_URL up).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'test', 'cloudflared.log');
const CLOUDFLARED = path.join(ROOT, 'tools', 'cloudflared.exe');

if (!fs.existsSync(CLOUDFLARED)) {
  console.error(`cloudflared not found at ${CLOUDFLARED}`);
  process.exit(1);
}

// 1. kill any running cloudflared (its hostname is dead or will die anyway)
try {
  execSync('taskkill /IM cloudflared.exe /F', { stdio: 'ignore' });
} catch (_) { /* none running */ }

// 2. start detached with captured output
try {
  fs.unlinkSync(LOG);
} catch (_) {}
const out = fs.openSync(LOG, 'a');
const err = fs.openSync(LOG, 'a');
const proc = spawn(CLOUDFLARED, ['tunnel', '--url', 'http://localhost:5000', '--no-autoupdate'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, err],
});
proc.unref();

// 3. wait for the URL (trycloudflare prints it once the tunnel is registered)
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let url = null;
for (let i = 0; i < 60 && !url; i++) {
  try {
    const text = fs.readFileSync(LOG, 'utf8');
    const m = text.match(URL_RE);
    if (m) url = m[0];
  } catch (_) {}
  if (!url) await new Promise((r) => setTimeout(r, 1000));
}
if (!url) {
  console.error('Tunnel did not report a URL within 60 s — check test/cloudflared.log');
  process.exit(1);
}

// 4. repoint .env BASE_URL and the _redirects tunnel lines
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const prev = (fs.readFileSync(envPath, 'utf8').match(/^BASE_URL=(\S+)/m) || [])[1];
  if (prev && prev !== url) {
    fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8').replace(prev, url));
  } else {
    // append when unset
    if (!/BASE_URL/.test(fs.readFileSync(envPath, 'utf8'))) {
      fs.appendFileSync(envPath, `\nBASE_URL=${url}\n`);
    }
  }
}

const redirects = path.join(ROOT, '.freebuff', 'netlify-deploy', '_redirects');
if (fs.existsSync(redirects)) {
  const body = fs.readFileSync(redirects, 'utf8');
  if (URL_RE.test(body)) {
    fs.writeFileSync(redirects, body.replace(URL_RE, url));
  }
}

console.log('Tunnel URL:', url);
console.log('.env BASE_URL and _redirects updated.');
console.log('NOW RESTART the node server (qrService reads BASE_URL at startup):');
console.log('  kill the :5000 pid, then start server.js detached.');
