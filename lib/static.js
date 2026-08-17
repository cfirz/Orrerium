import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function serveStatic(publicDir, urlPath, res) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return notFound(res);
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const root = path.resolve(publicDir);
  const resolved = path.resolve(root, '.' + rel.replace(/\\/g, '/'));
  // win32 fs is case-insensitive, so the containment check must be too
  const inRoot = (resolved.toLowerCase() + path.sep).startsWith(root.toLowerCase() + path.sep);
  if (!inRoot || !existsSync(resolved) || !statSync(resolved).isFile()) return notFound(res);

  const type = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  // no-cache, or the browser's heuristic cache serves stale modules after edits
  // (nothing here sends validators, so heuristics would otherwise kick in)
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(resolved).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}
