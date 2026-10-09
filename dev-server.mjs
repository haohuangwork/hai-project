// Local dev server (Node equivalent of server.py): serves static files and proxies POST /api/chat
// to the Anthropic Messages API with streaming. Reads ANTHROPIC_API_KEY from .env.
// Run: node dev-server.mjs   (PORT env var overrides the default 3000)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
}

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function proxyChat(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { res.writeHead(400, CORS); return res.end('Bad JSON'); }

  try {
    const upstream = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        stream: true,
        system: payload.system || '',
        messages: payload.messages || [],
      }),
    });
    if (!upstream.ok) {
      res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(await upstream.text());
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(String(e.message || e));
  }
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'POST' && url === '/api/chat') return proxyChat(req, res);
  if (req.method !== 'GET') { res.writeHead(404); return res.end(); }

  const rel = url === '/' ? '/index.html' : decodeURIComponent(url);
  const file = path.join(root, rel);
  // Only serve files inside the project, and never dotfiles such as .env
  if (!file.startsWith(root + path.sep) || path.basename(file).startsWith('.') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Serving on port ${PORT}`));
