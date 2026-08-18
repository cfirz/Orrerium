// Collecting POST bodies with a size cap. Over the cap the request is answered
// 413 and torn down; callers get null and simply return. Shared by every JSON
// route in server.js so the refusal behaviour stays uniform.
export function readBody(req, res, limit) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        // answer before tearing down - destroying the socket immediately
        // races the 413 bytes still queued behind the client's upload
        res.writeHead(413, {
          'Content-Type': 'application/json; charset=utf-8',
          Connection: 'close',
        });
        res.end(JSON.stringify({ error: `body too large (max ${limit} bytes)` }));
        res.once('finish', () => req.destroy());
        // a client that streams forever without reading the response never
        // lets 'finish' fire - cap how long the socket can linger
        setTimeout(() => req.destroy(), 2000).unref();
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!refused) resolve(body);
    });
    req.on('error', () => {
      // client went away mid-upload - nothing to answer, nothing to parse
      if (!refused) {
        refused = true;
        resolve(null);
      }
    });
  });
}
