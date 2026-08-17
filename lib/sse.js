// One SSE endpoint, named events. Kept out of server.js so later modules
// (agents, crons) can broadcast without touching http routing.
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(msg);
}

// keep intermediaries from killing idle SSE sockets
setInterval(() => {
  for (const client of clients) client.write(': ping\n\n');
}, 25_000).unref();
