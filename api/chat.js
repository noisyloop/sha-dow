// Vercel function: the whole chat API lives at /api/chat?a=...
import { handle } from '../lib/chat.js';
import { createStore, storageVarNames } from '../lib/store.js';

let store;

export default async function chat(req, res) {
  try {
    store ||= createStore();
  } catch (err) {
    if (String(req.url).endsWith('?a=health')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ storage: 'none', ok: false, found: storageVarNames() }));
      return;
    }
    console.error(err.message);
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Storage not set up. Add a Redis database in Vercel → Storage, then redeploy.' }));
    return;
  }
  return handle(req, res, store);
}
