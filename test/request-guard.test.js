import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, isLoopback, loopbackHosts } from '../lib/request-guard.js';

const LOCAL = { host: '127.0.0.1', port: 4321 };
const req = (method, headers) => ({ method, headers: { host: '127.0.0.1:4321', ...headers } });

test('the dashboard and hook relay pass', () => {
  assert.equal(checkRequest(req('GET', {}), LOCAL), null);
  assert.equal(checkRequest(req('GET', { host: 'localhost:4321' }), LOCAL), null);
  assert.equal(checkRequest(req('GET', { host: '[::1]:4321' }), LOCAL), null);
  // hooks/emit.js: Node fetch sends no Origin and no Sec-Fetch-Site
  assert.equal(checkRequest(req('POST', { 'content-type': 'application/json' }), LOCAL), null);
  // the dashboard's own fetch from its page
  assert.equal(checkRequest(req('POST', { origin: 'http://127.0.0.1:4321', 'sec-fetch-site': 'same-origin' }), LOCAL), null);
  assert.equal(checkRequest(req('POST', { host: 'localhost:4321', origin: 'http://localhost:4321' }), LOCAL), null);
});

test('DNS rebinding: a foreign Host is refused, even for reads', () => {
  const r = checkRequest(req('GET', { host: 'evil.example:4321' }), LOCAL);
  assert.equal(r.status, 403);
  assert.equal(checkRequest(req('GET', { host: '127.0.0.1:9999' }), LOCAL).status, 403);
  assert.equal(checkRequest(req('GET', { host: undefined }), LOCAL).status, 403);
  // a malformed Host must be refused here, never reach new URL()
  assert.equal(checkRequest(req('GET', { host: 'x:99999' }), LOCAL).status, 403);
});

test('cross-site writes are refused by Origin or Sec-Fetch-Site', () => {
  assert.equal(checkRequest(req('POST', { origin: 'https://evil.example' }), LOCAL).status, 403);
  assert.equal(checkRequest(req('POST', { origin: 'null' }), LOCAL).status, 403); // sandboxed iframe, data: URL
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'cross-site' }), LOCAL).status, 403);
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'same-site' }), LOCAL).status, 403);
  assert.equal(checkRequest(req('DELETE', { origin: 'https://evil.example' }), LOCAL).status, 403);
  // a typed URL bar navigation reports none - harmless for a GET anyway
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'none' }), LOCAL), null);
});

test('cross-site reads pass the guard - CORS keeps their responses unreadable', () => {
  assert.equal(checkRequest(req('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), LOCAL), null);
});

test('a deliberately exposed listener skips Host pinning but still checks Origin', () => {
  const open = { host: '0.0.0.0', port: 4321 };
  assert.equal(checkRequest(req('GET', { host: 'my-box.lan:4321' }), open), null);
  assert.equal(checkRequest(req('POST', { host: 'my-box.lan:4321', origin: 'http://my-box.lan:4321' }), open), null);
  assert.equal(checkRequest(req('POST', { host: 'my-box.lan:4321', origin: 'https://evil.example' }), open).status, 403);
});

test('loopback helpers', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('localhost') && isLoopback('::1') && isLoopback('LOCALHOST'));
  assert.ok(!isLoopback('0.0.0.0') && !isLoopback('192.168.1.5'));
  assert.ok(loopbackHosts(80).has('localhost')); // browsers drop the default port
  assert.ok(!loopbackHosts(4321).has('localhost'));
});
