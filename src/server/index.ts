import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createApi } from './api.js';
import { MemoryStore, createNeo4jStore } from './store.js';
import { seedDemo } from './demo.js';
const demo = process.env.DEMO_MODE === 'true';
if (
  !demo &&
  [process.env.READ_TOKEN, process.env.WRITE_TOKEN].some(
    (t) => !t || t.length < 24 || t.startsWith('replace-'),
  )
)
  throw new Error('Set distinct READ_TOKEN and WRITE_TOKEN (at least 24 characters each)');
if (!demo && process.env.READ_TOKEN === process.env.WRITE_TOKEN)
  throw new Error('Reader and collector tokens must differ');
const store = demo ? new MemoryStore() : createNeo4jStore();
if (store instanceof MemoryStore) await seedDemo(store);
else await store.initialize();
const api = createApi(store, {
  demo,
  readToken: process.env.READ_TOKEN,
  writeToken: process.env.WRITE_TOKEN,
});
const root = resolve('dist/web');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: demo ? 'demo' : 'live' }));
      return;
    }
    if (url.pathname === '/graphql') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) {
          res.writeHead(413);
          res.end('Payload too large');
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      const response = await api.fetch(
        new Request(url, {
          method: req.method,
          headers,
          ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    const path = resolve(
      root,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const contents = await readFile(path);
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found. Build the UI with npm run build.');
    } else {
      console.error(error);
      res.writeHead(500);
      res.end('Internal server error');
    }
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? 4000), process.env.HOST ?? '127.0.0.1', () =>
  console.log(
    `SourceAtlas ${demo ? 'DEMO (in-memory)' : 'Neo4j'} → http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 4000}`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await store.close();
      process.exit(0);
    }),
  );
