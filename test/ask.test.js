import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVault, parseSkills } from '../lib/vault.js';
import {
  apiEventText, ask, buildContext, buildSystem, cliEventText,
  createLineParser, createSseParser, resolveProvider,
} from '../lib/ask.js';

const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

test('resolveProvider honours explicit setting and auto-detects', () => {
  assert.equal(resolveProvider({ provider: 'api' }), 'api');
  assert.equal(resolveProvider({ provider: 'cli' }), 'cli');

  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(resolveProvider({ provider: 'auto' }), 'api');
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(resolveProvider({ provider: 'auto' }), 'cli');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('buildContext includes notes and skills, excludes templates', () => {
  const { notes } = parseVault(FIXTURE_VAULT);
  const { skills } = parseSkills(FIXTURE_VAULT);
  const ctx = buildContext(notes, skills);

  assert.match(ctx, /## \[\[alpha\]\] \(project/);
  assert.match(ctx, /Test project alpha/);       // description included
  assert.match(ctx, /\*\*Alpha\*\* is the hub/); // body included
  assert.match(ctx, /## \[\[testskill\]\] \(routine\)/);
  assert.doesNotMatch(ctx, /template-note/);     // templates excluded
});

test('buildSystem wraps context and demands wikilink citations', () => {
  const system = buildSystem('THE-CONTEXT');
  assert.match(system, /<vault>\nTHE-CONTEXT\n<\/vault>/);
  assert.match(system, /\[\[note-id\]\]/);
  assert.match(system, /ONLY the vault notes/);
});

// --- stream parsers -------------------------------------------------------

test('createSseParser buffers across chunk boundaries, tolerates CRLF and noise', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('event: message_start\r\ndata: {"type":"messa'), []);
  assert.deepEqual(p.push('ge_start"}\r\n\r\ndata: not json\n'), [{ type: 'message_start' }]);
  assert.deepEqual(
    p.push(': comment\ndata: {"n":2}\n\ndata: {"tail":true}'), // last line unterminated
    [{ n: 2 }],
  );
  assert.deepEqual(p.push('\n'), [{ tail: true }]); // the newline completes it
});

test('createLineParser splits NDJSON and skips non-JSON --verbose noise', () => {
  const p = createLineParser();
  assert.deepEqual(p.push('{"a":1}\nplain log line\n{"b":'), [{ a: 1 }]);
  assert.deepEqual(p.push('2}\n\n'), [{ b: 2 }]);
});

test('event text extractors pick only text deltas', () => {
  const delta = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
  assert.equal(apiEventText(delta), 'hi');
  assert.equal(apiEventText({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), null);
  assert.equal(apiEventText({ type: 'message_stop' }), null);
  assert.equal(cliEventText({ type: 'stream_event', event: delta }), 'hi');
  assert.equal(cliEventText({ type: 'result', result: 'x' }), null);
});

// --- api provider streaming (against a local SSE stand-in) ----------------

async function withSseServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1/messages`);
  } finally {
    server.close();
  }
}

function withApiKey(fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });
}

test('askApi streams SSE deltas, split mid-line, into onDelta and the answer', () =>
  withApiKey(() => {
    let requestBody;
    return withSseServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        // one delta split across two socket writes exercises the line buffer
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_del');
        setTimeout(() => {
          res.write('ta","text":"Hello "}}\n\n');
          res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[[alpha]]"}}\n\n');
          res.write('data: {"type":"message_stop"}\n\n');
          res.end();
        }, 10);
      });
    }, async (apiUrl) => {
      const deltas = [];
      const result = await ask('q', {
        notes: [], skills: [],
        ai: { provider: 'api', model: 'claude-test', timeoutMs: 5000, apiUrl },
        onDelta: (t) => deltas.push(t),
      });
      assert.deepEqual(deltas, ['Hello ', '[[alpha]]']);
      assert.equal(result.answer, 'Hello [[alpha]]');
      assert.equal(result.provider, 'api');
      assert.equal(result.model, 'claude-test');
      assert.equal(requestBody.stream, true);
      assert.equal(requestBody.system[0].cache_control.type, 'ephemeral'); // caching survives streaming
    });
  }));

test('askApi surfaces a mid-stream error event as a rejection', () =>
  withApiKey(() => withSseServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
    res.end();
  }, async (apiUrl) => {
    await assert.rejects(
      ask('q', { notes: [], skills: [], ai: { provider: 'api', model: 'm', timeoutMs: 5000, apiUrl }, onDelta: () => {} }),
      /Overloaded/,
    );
  })));

// --- cli provider streaming (against a fake claude shim) ------------------

// a wrapper the platform can execute plus the node impl it delegates to; the
// impl echoes stream-json events, or plain text when spawned without the
// streaming flags, and FAKE_CLI_MODE=old refuses them like an outdated CLI
const shimDir = mkdtempSync(path.join(tmpdir(), 'orrerium-fakecli-'));
writeFileSync(path.join(shimDir, 'impl.js'), `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const streaming = process.argv.includes('stream-json');
  if (process.env.FAKE_CLI_MODE === 'old' && streaming) {
    process.stderr.write('error: unknown option --include-partial-messages');
    process.exit(1);
  }
  if (!streaming) { process.stdout.write('buffered answer'); process.exit(0); }
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-test' },
    'verbose noise, not JSON',
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'vault' } } },
    { type: 'result', subtype: 'success', result: 'Hello vault!' },
  ];
  for (const e of events) process.stdout.write((typeof e === 'string' ? e : JSON.stringify(e)) + '\\n');
  process.exit(0);
});
`);
let fakeCli;
if (process.platform === 'win32') {
  fakeCli = path.join(shimDir, 'fake-claude.cmd');
  writeFileSync(fakeCli, `@echo off\r\nnode "%~dp0impl.js" %*\r\nexit /b %ERRORLEVEL%\r\n`);
} else {
  fakeCli = path.join(shimDir, 'fake-claude.sh');
  writeFileSync(fakeCli, `#!/bin/sh\nexec node "$(dirname "$0")/impl.js" "$@"\n`, { mode: 0o755 });
}
const cliAi = { provider: 'cli', cliCommand: fakeCli, timeoutMs: 10_000 };

test('askCli streams stream-json deltas; the result event text is authoritative', async () => {
  const deltas = [];
  const result = await ask('q', { notes: [], skills: [], ai: cliAi, onDelta: (t) => deltas.push(t) });
  assert.deepEqual(deltas, ['Hello ', 'vault']);
  assert.equal(result.answer, 'Hello vault!'); // from the result event, not the deltas
  assert.equal(result.provider, 'cli');
});

test('askCli falls back to buffered text mode when the CLI rejects the streaming flags', async () => {
  process.env.FAKE_CLI_MODE = 'old';
  try {
    const deltas = [];
    const result = await ask('q', { notes: [], skills: [], ai: cliAi, onDelta: (t) => deltas.push(t) });
    assert.deepEqual(deltas, []); // no streaming, but still an answer
    assert.equal(result.answer, 'buffered answer');
  } finally {
    delete process.env.FAKE_CLI_MODE;
  }
});
