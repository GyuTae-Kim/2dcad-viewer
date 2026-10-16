// Finite CI preview: use compression like GitHub Pages, rather than measuring
// Python's uncompressed HTML/JS as though those were the production transfer sizes.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Valid port required');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const cache = new Map();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('Invalid path');
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    } catch { file += '.html'; }
    if (!cache.has(file)) {
      const bytes = await readFile(file);
      cache.set(file, { bytes, compressed: /\.(html|css|js|json|xml|svg|webmanifest)$/.test(file) ? gzipSync(bytes) : null });
    }
    const { bytes, compressed } = cache.get(file);
    const gzip = compressed && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
    const body = gzip ? compressed : bytes;
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length, Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  }
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close());
