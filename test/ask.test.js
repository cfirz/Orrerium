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
  createLineParser, createSseParser, openAiEventText, resolveKey, resolveProvider,
} from '../lib/ask.js';

const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

// runs fn with the provider key env vars cleared and `vars` applied, then
// restores everything - keeps tests deterministic on machines with real keys
const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY'];
function withEnv(vars, fn) {
  const names = [...new Set([...KEY_VARS, ...Object.keys(vars)])];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const [n, v] of Object.entries(vars)) {
    if (v != null) process.env[n] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });
}

test('resolveProvider honours explicit ids, aliases "api", and auto-detects in order', () =>
  withEnv({}, () => {
    assert.equal(resolveProvider({ provider: 'cli' }), 'cli');
    assert.equal(resolveProvider({ provider: 'api' }), 'anthropic'); // pre-0.3 alias
    for (const id of ['anthropic', 'openai', 'gemini', 'grok', 'ollama']) {
      assert.equal(resolveProvider({ provider: id }), id);
    }
    assert.equal(resolveProvider({ provider: 'auto' }), 'cli'); // no keys anywhere
    process.env.XAI_API_KEY = 'k';
    assert.equal(resolveProvider({ provider: 'auto' }), 'grok');
    process.env.GEMINI_API_KEY = 'k';
    assert.equal(resolveProvider({ provider: 'auto' }), 'gemini');
    process.env.OPENAI_API_KEY = 'k';
    assert.equal(resolveProvider({ provider: 'auto' }), 'openai');
    process.env.ANTHROPIC_API_KEY = 'k';
    assert.equal(resolveProvider({ provider: 'auto' }), 'anthropic');
  }));

test('resolveProvider: GOOGLE_API_KEY alone never triggers auto-detection', () =>
  withEnv({ GOOGLE_API_KEY: 'g' }, () => {
    assert.equal(resolveProvider({ provider: 'auto' }), 'cli');
  }));

test('resolveKey resolves the env key and the per-provider default model', () =>
  withEnv({ OPENAI_API_KEY: 'sk-oa' }, () => {
    const r = resolveKey('openai', {});
    assert.equal(r.key, 'sk-oa');
    assert.equal(r.model, 'gpt-5.6-terra');
    assert.equal(resolveKey('openai', { model: 'custom-model' }).model, 'custom-model');
    assert.throws(() => resolveKey('grok', {}), /XAI_API_KEY/); // names the missing var
  }));

test('resolveKey: GOOGLE_API_KEY works for explicit gemini, keyEnv overrides, ollama demands a model', () =>
  withEnv({ GOOGLE_API_KEY: 'g-key', MY_PROXY_KEY: 'p-key' }, () => {
    assert.equal(resolveKey('gemini', {}).key, 'g-key');
    assert.equal(resolveKey('grok', { keyEnv: 'MY_PROXY_KEY' }).key, 'p-key');
    assert.deepEqual(resolveKey('ollama', { model: 'llama3' }), { key: null, model: 'llama3' });
    assert.throws(() => resolveKey('ollama', {}), /ai\.model/);
  }));

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

test('openAiEventText picks only content deltas', () => {
  assert.equal(openAiEventText({ choices: [{ delta: { content: 'hi' } }] }), 'hi');
  assert.equal(openAiEventText({ choices: [{ delta: { role: 'assistant' } }] }), null);
  assert.equal(openAiEventText({ choices: [{ delta: { content: '' } }] }), null);
  assert.equal(openAiEventText({ choices: [] }), null);
  assert.equal(openAiEventText(null), null);
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

const withApiKey = (fn) => withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, fn);

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
      assert.equal(result.provider, 'anthropic'); // "api" resolves to its new name
      assert.equal(result.model, 'claude-test');
      assert.equal(requestBody.stream, true);
      assert.equal(requestBody.system[0].cache_control.type, 'ephemeral'); // caching survives streaming
      assert.doesNotMatch(requestBody.system[0].text, /too large for one context/); // under budget: no retrieval notice
    });
  }));

test('an over-budget vault ships a retrieval-filtered context with the notice', () =>
  withApiKey(() => {
    let requestBody;
    return withSseServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
        res.end();
      });
    }, async (apiUrl) => {
      const base = { path: 'x.md', folder: 'projects', type: 'project', description: null,
        tags: [], updated: null, status: null, dir: null, projectLinks: [], bodyLinks: [], docLinks: [] };
      // no token overlap between the question and boring-note, or BM25 would
      // legitimately count it a (weak) match
      const notes = [
        { ...base, id: 'orbital-note', name: 'orbital-note', rawBody: 'orbital mechanics: apoapsis, periapsis, delta-v budgets, transfer windows, burn timing references' },
        { ...base, id: 'boring-note', name: 'boring-note', rawBody: 'compost heap layout, watering schedule, seasonal pruning reminders, garden bed rotation, mulch supplier list' },
      ];
      const result = await ask('explain orbital mechanics', {
        notes, skills: [],
        ai: { provider: 'api', model: 'm', timeoutMs: 5000, apiUrl, maxContextTokens: 50 },
        onDelta: () => {},
      });
      assert.equal(result.answer, 'ok');
      const system = requestBody.system[0].text;
      assert.match(system, /\[\[orbital-note\]\]/);
      assert.doesNotMatch(system, /\[\[boring-note\]\]/);
      assert.match(system, /too large for one context/);
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

test('a missing key rejects before any request goes out', () =>
  withEnv({}, async () => {
    await assert.rejects(
      ask('q', { notes: [], skills: [], ai: { provider: 'openai', timeoutMs: 5000 }, onDelta: () => {} }),
      /OPENAI_API_KEY/,
    );
    await assert.rejects( // the fixed pre-0.3 gap: explicit api with no key
      ask('q', { notes: [], skills: [], ai: { provider: 'api', timeoutMs: 5000 }, onDelta: () => {} }),
      /ANTHROPIC_API_KEY/,
    );
  }));

// --- openai-compatible provider streaming (same local stand-in) -----------

test('askOpenAi streams Chat Completions deltas and sends the compat request shape', () =>
  withEnv({ OPENAI_API_KEY: 'sk-oa' }, () => {
    let requestBody;
    let authHeader;
    return withSseServer((req, res) => {
      authHeader = req.headers.authorization;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
        // one delta split across two socket writes exercises the line buffer
        res.write('data: {"choices":[{"delta":{"content":"Hel');
        setTimeout(() => {
          res.write('lo "}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"[[alpha]]"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, 10);
      });
    }, async (apiUrl) => {
      const deltas = [];
      const result = await ask('q', {
        notes: [], skills: [],
        ai: { provider: 'openai', timeoutMs: 5000, apiUrl },
        onDelta: (t) => deltas.push(t),
      });
      assert.deepEqual(deltas, ['Hello ', '[[alpha]]']);
      assert.equal(result.answer, 'Hello [[alpha]]');
      assert.equal(result.provider, 'openai');
      assert.equal(result.model, 'gpt-5.6-terra'); // registry default applied
      assert.equal(authHeader, 'Bearer sk-oa');
      assert.equal(requestBody.stream, true);
      assert.equal(requestBody.model, 'gpt-5.6-terra');
      assert.equal(requestBody.messages[0].role, 'system'); // vault context leads
      assert.equal(requestBody.messages.at(-1).content, 'q');
      assert.ok(!('max_tokens' in requestBody) && !('max_completion_tokens' in requestBody));
      assert.ok(!('system' in requestBody)); // no Anthropic-style top-level system
    });
  }));

test('askOpenAi surfaces mid-stream errors and both HTTP error envelope shapes', () =>
  withEnv({ OPENAI_API_KEY: 'sk-oa' }, async () => {
    await withSseServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"error":{"message":"rate limited"}}\n\n');
      res.end();
    }, (apiUrl) => assert.rejects(
      ask('q', { notes: [], skills: [], ai: { provider: 'openai', timeoutMs: 5000, apiUrl }, onDelta: () => {} }),
      /rate limited/,
    ));
    await withSseServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"model not found"}'); // bare-string envelope (Ollama shape)
    }, (apiUrl) => assert.rejects(
      ask('q', { notes: [], skills: [], ai: { provider: 'openai', timeoutMs: 5000, apiUrl }, onDelta: () => {} }),
      /model not found/,
    ));
  }));

test('askOpenAi rejects refusals in both buffered and streaming modes', () =>
  withEnv({ OPENAI_API_KEY: 'sk-oa' }, async () => {
    await withSseServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"refusal":"no"}}]}');
    }, (apiUrl) => assert.rejects( // buffered: no onDelta
      ask('q', { notes: [], skills: [], ai: { provider: 'openai', timeoutMs: 5000, apiUrl } }),
      /declined/,
    ));
    await withSseServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"refusal":"no"}}]}\n\ndata: [DONE]\n\n');
      res.end();
    }, (apiUrl) => assert.rejects(
      ask('q', { notes: [], skills: [], ai: { provider: 'openai', timeoutMs: 5000, apiUrl }, onDelta: () => {} }),
      /declined/,
    ));
  }));

test('ollama needs no key and sends no authorization header', () =>
  withEnv({}, () => {
    let authHeader = 'unset';
    return withSseServer((req, res) => {
      authHeader = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"local answer"}}]}');
    }, async (apiUrl) => {
      const result = await ask('q', {
        notes: [], skills: [],
        ai: { provider: 'ollama', model: 'llama3', timeoutMs: 5000, apiUrl },
      });
      assert.equal(result.answer, 'local answer');
      assert.equal(result.model, 'llama3');
      assert.equal(authHeader, undefined);
    });
  }));

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
  assert.equal(result.model, 'claude-test'); // from the init event
});

test('askCli falls back to buffered text mode when the CLI rejects the streaming flags', async () => {
  process.env.FAKE_CLI_MODE = 'old';
  try {
    const deltas = [];
    const result = await ask('q', { notes: [], skills: [], ai: cliAi, onDelta: (t) => deltas.push(t) });
    assert.deepEqual(deltas, []); // no streaming, but still an answer
    assert.equal(result.answer, 'buffered answer');
    assert.equal(result.model, 'claude-cli default'); // text mode emits no init event
  } finally {
    delete process.env.FAKE_CLI_MODE;
  }
});
