// Local dev server: static files + the same /api/chat handler Vercel runs, with an in-memory store
// (or real Redis if KV_REST_API_URL / KV_REST_API_TOKEN are set).
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/chat.js';
import { createStore } from './lib/store.js';
import { SECURITY_HEADERS } from './lib/headers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, process.env.STATIC_DIR || (existsSync(path.join(HERE, 'dist', 'index.html')) ? 'dist' : 'public'));
const PORT = Number(process.env.PORT) || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createServer(store = createStore()) {
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/chat') return handle(req, res, store);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();

    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    } catch {
      return res.writeHead(400).end();
    }
    const file = path.resolve(ROOT, rel);
    const type = MIME[path.extname(file)];
    if (!file.startsWith(ROOT + path.sep) || !type) return res.writeHead(404).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`sha-dow on http://localhost:${PORT} (serving ${path.basename(ROOT)}/)`));
}
