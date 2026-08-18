import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'emit.js');

// an ephemeral stand-in for the Orrerium server, collecting what emit.js posts
function withServer(fn) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(server.address().port, received));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

// keepStdinOpen leaves the pipe dangling on purpose: arg mode must exit
// without ever waiting on stdin (Codex attaches nothing to it)
function runEmit({ port, args = [], stdin = null, keepStdinOpen = false }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EMIT, ...args], {
      env: { ...process.env, ORRERIUM_PORT: String(port) },
      windowsHide: true,
    });
    child.on('close', (code) => resolve(code));
    if (stdin != null) child.stdin.end(stdin);
    else if (!keepStdinOpen) child.stdin.end();
  });
}

test('stdin mode relays the payload verbatim, without a source query', () =>
  withServer(async (port, received) => {
    const code = await runEmit({ port, stdin: '{"hook_event_name":"Stop","session_id":"s1"}' });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/hook-event');
    assert.equal(received[0].body, '{"hook_event_name":"Stop","session_id":"s1"}');
  }));

test('--source lands as a query parameter and a BOM is stripped', () =>
  withServer(async (port, received) => {
    const code = await runEmit({ port, args: ['--source=gemini-cli'], stdin: '﻿{"hook_event_name":"BeforeTool"}' });
    assert.equal(code, 0);
    assert.equal(received[0].url, '/api/hook-event?source=gemini-cli');
    assert.equal(received[0].body, '{"hook_event_name":"BeforeTool"}');
  }));

test('argv mode posts the argument without touching stdin', () =>
  withServer(async (port, received) => {
    const payload = '{"type":"agent-turn-complete","turn-id":"t1"}';
    const code = await runEmit({ port, args: ['--source=codex', payload], keepStdinOpen: true });
    assert.equal(code, 0); // exited although stdin never closed
    assert.equal(received[0].url, '/api/hook-event?source=codex');
    assert.equal(received[0].body, payload);
  }));

test('exits 0 when no server is listening', async () => {
  const code = await runEmit({ port: 1, stdin: '{}' }); // nothing listens on port 1
  assert.equal(code, 0);
});
