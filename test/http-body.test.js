import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readBody } from '../lib/http-body.js';

// a real server + client because the refusal path is about socket behaviour;
// http.request (not fetch) so the 413 is readable even on a cut-short upload
function withServer(fn) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req, res, 64); // tiny limit for the tests
    seen.push(body);
    if (body === null) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echoed: body }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(server.address().port, seen));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('a body under the limit is delivered intact', () =>
  withServer(async (port, seen) => {
    const res = await post(port, '{"ok":true}');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.data), { echoed: '{"ok":true}' });
    assert.deepEqual(seen, ['{"ok":true}']);
  }));

test('an oversized body gets a 413 JSON error and the handler gets null', () =>
  withServer(async (port, seen) => {
    const res = await post(port, 'x'.repeat(200));
    assert.equal(res.status, 413);
    assert.match(JSON.parse(res.data).error, /body too large \(max 64 bytes\)/);
    assert.deepEqual(seen, [null]);
  }));

test('an empty body resolves to an empty string, not null', () =>
  withServer(async (port, seen) => {
    const res = await post(port, '');
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['']);
  }));
