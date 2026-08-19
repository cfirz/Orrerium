// Ask-your-brain: answers questions over the vault's notes with an LLM.
// Providers (config.json ai.provider, auto-detected by default):
//   anthropic          - raw HTTP against the Claude API (zero-dependency
//                        constraint rules out the SDK)
//   openai/gemini/grok - the same OpenAI-compatible Chat Completions dialect
//                        on each vendor's endpoint
//   ollama             - that dialect against a local server; no key needed
//   cli                - spawns the local `claude` CLI, which uses the user's
//                        existing Claude Code login (no API key needed)
// All stream: pass onDelta to receive answer text as it is generated (the
// APIs via SSE, the CLI via --output-format stream-json); without onDelta the
// providers make their original buffered calls.
import { spawn } from 'node:child_process';
import { resolveCliInvocation } from './cli-spawn.js';
import { estimateTokens, selectContext } from './retrieve.js';

// Provider registry. dialect selects the request/stream adapter; keyEnv lists
// accepted env var names (first set wins); autoDetect gates "auto" -
// GOOGLE_API_KEY is honoured when gemini is chosen explicitly but never
// triggers auto (it exists on many machines for unrelated Google services).
// defaultModel values are config data - update freely as vendors ship models.
export const PROVIDERS = {
  anthropic: {
    dialect: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: ['ANTHROPIC_API_KEY'], autoDetect: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-opus-5', label: 'Anthropic API',
  },
  openai: {
    dialect: 'openai', baseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'], autoDetect: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-5.6-terra', label: 'OpenAI API',
  },
  gemini: {
    dialect: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], autoDetect: ['GEMINI_API_KEY'],
    defaultModel: 'gemini-3.7-flash', label: 'Google Gemini API',
  },
  grok: {
    dialect: 'openai', baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'], autoDetect: ['XAI_API_KEY'],
    defaultModel: 'grok-4.5', label: 'xAI Grok API',
  },
  ollama: {
    dialect: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: [], autoDetect: [], defaultModel: null, label: 'Ollama',
  },
};

// deterministic auto-detection order; anthropic first preserves the pre-0.3
// behaviour for existing setups, cli last because it needs an install
const AUTO_ORDER = ['anthropic', 'openai', 'gemini', 'grok'];

export function resolveProvider(aiConfig) {
  if (aiConfig.provider === 'cli') return 'cli';
  if (aiConfig.provider === 'api') return 'anthropic'; // pre-0.3 name, kept as an alias
  if (PROVIDERS[aiConfig.provider]) return aiConfig.provider;
  for (const id of AUTO_ORDER) {
    if (PROVIDERS[id].autoDetect.some((name) => process.env[name])) return id;
  }
  return 'cli';
}

// Preflight: resolve the API key and model before any request goes out, so a
// missing key fails with a message naming the env var instead of a vendor 401.
// ai.keyEnv names an env variable; the key value itself never touches disk.
export function resolveKey(provider, ai) {
  const preset = PROVIDERS[provider];
  const model = ai.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(`set ai.model in config.json - the "${provider}" provider has no default model`);
  }
  const names = ai.keyEnv ? [ai.keyEnv] : preset.keyEnv;
  if (names.length === 0) return { key: null, model };
  const name = names.find((n) => process.env[n]);
  if (!name) {
    throw new Error(`the "${provider}" provider needs ${names.join(' or ')} set in the environment`);
  }
  return { key: process.env[name], model };
}

function endpointFor(provider, ai) {
  if (ai.apiUrl) return ai.apiUrl; // test seam: a full endpoint URL, as-is
  const base = (ai.baseUrl ?? PROVIDERS[provider].baseUrl).replace(/\/+$/, '');
  return base + (PROVIDERS[provider].dialect === 'anthropic' ? '/messages' : '/chat/completions');
}

export function buildContext(notes, skills = []) {
  const parts = [];
  const order = { root: 0, project: 1, lesson: 2, machine: 3, idea: 4 };
  const sorted = [...notes]
    .filter((n) => n.type !== 'template')
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  for (const n of sorted) {
    const tags = n.tags?.length ? ` — tags: ${n.tags.join(', ')}` : '';
    const desc = n.description ? `\n${n.description}` : '';
    parts.push(`## [[${n.id}]] (${n.type}${tags})${desc}\n\n${(n.rawBody ?? '').trim()}`);
  }
  for (const s of skills) {
    parts.push(`## [[${s.id}]] (routine)\n${s.description ?? ''}\n\n${(s.rawBody ?? '').trim()}`);
  }
  return parts.join('\n\n---\n\n');
}

export function buildSystem(context, { filtered = false } = {}) {
  const filteredNote = filtered
    ? '\n\nThe vault is too large for one context, so only the notes selected as relevant to this conversation are included below. Other notes exist: if the included notes do not contain the answer, say the answer may live in a note not shown here - do not guess.'
    : '';
  return `You are the librarian of a personal knowledge vault called the Brain. Answer the user's question using ONLY the vault notes below.

- Whenever you mention a note, cite it as a wikilink: [[note-id]]. These render as clickable links in the UI, so cite generously.
- Answer in concise markdown. Lead with the answer; keep it short unless depth is asked for.
- If the vault does not contain the answer, say so plainly - do not invent vault content.${filteredNote}

<vault>
${context}
</vault>`;
}

// --- stream plumbing: line-buffered parsers, pure and importable ----------

// SSE from the Claude API: every payload rides a single-line `data: {json}`;
// event:/id:/comment lines carry nothing the data JSON does not repeat
export function createSseParser() {
  let buf = '';
  return {
    push(text) {
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop();
      const events = [];
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line.startsWith('data:')) continue;
        try {
          events.push(JSON.parse(line.slice(5).trimStart()));
        } catch {
          // a non-JSON data line - nothing of ours
        }
      }
      return events;
    },
  };
}

// NDJSON from `claude --output-format stream-json`; unparseable lines are
// --verbose noise and skipped
export function createLineParser() {
  let buf = '';
  return {
    push(text) {
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop();
      const events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // not an event line
        }
      }
      return events;
    },
  };
}

export const apiEventText = (evt) =>
  (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') ? evt.delta.text : null;

// the CLI wraps raw API stream events under {type:"stream_event", event:{...}}
export const cliEventText = (evt) =>
  (evt?.type === 'stream_event' ? apiEventText(evt.event) : null);

// OpenAI-compatible stream chunks carry text under choices[0].delta.content;
// role-only deltas and the `data: [DONE]` sentinel (non-JSON, dropped by the
// SSE parser) carry none
export const openAiEventText = (evt) => {
  const d = evt?.choices?.[0]?.delta;
  return typeof d?.content === 'string' && d.content !== '' ? d.content : null;
};

// vendors wrap errors as {error:{message}}; some local servers send {error:"…"}
const errorMessage = (body) => {
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.error === 'string') return body.error;
  return null;
};

// --- entry point ----------------------------------------------------------

// onDelta(text) streams the answer as it generates; signal cancels the
// provider call (the http request or the CLI child) when the caller goes away
export async function ask(question, { notes, skills, ai, history = [], onDelta, signal }) {
  const provider = resolveProvider(ai);
  let context = buildContext(notes, skills);
  let filtered = false;
  const budget = ai.maxContextTokens ?? 120_000;
  if (estimateTokens(context) > budget) {
    // over the budget the context varies per question, so prompt-cache hits
    // stop - inherent to retrieval, and why the default budget is high
    const picked = selectContext({ question, history, notes, skills, budgetTokens: budget });
    context = buildContext(picked.notes, picked.skills);
    filtered = true;
  }
  const system = buildSystem(context, { filtered });
  if (provider === 'cli') {
    const { answer, model } = await askCli(system, question, history, ai, onDelta, signal);
    return { answer, provider, model: model ?? 'claude-cli default' };
  }
  const { key, model } = resolveKey(provider, ai);
  const answer = PROVIDERS[provider].dialect === 'anthropic'
    ? await askAnthropic(system, question, history, ai, provider, model, key, onDelta, signal)
    : await askOpenAi(system, question, history, ai, provider, model, key, onDelta, signal);
  return { answer, provider, model };
}

async function askAnthropic(system, question, history, ai, provider, model, key, onDelta, signal) {
  const stream = typeof onDelta === 'function';
  const signals = [AbortSignal.timeout(ai.timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(endpointFor(provider, ai), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      stream,
      // cache the vault context so repeated questions only pay for the question
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessage(body) ?? `${PROVIDERS[provider].label} returned ${res.status}`);
  }
  if (!stream) {
    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      throw new Error('The model declined to answer this question.');
    }
    return data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let answer = '';
  let refused = false;
  for await (const chunk of res.body) {
    for (const evt of parser.push(decoder.decode(chunk, { stream: true }))) {
      if (evt.type === 'error') throw new Error(evt.error?.message ?? 'stream error');
      if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'refusal') refused = true;
      const text = apiEventText(evt);
      if (text) {
        answer += text;
        onDelta(text);
      }
    }
  }
  // a refusal that still produced text keeps the text - the client saw it
  if (refused && !answer.trim()) throw new Error('The model declined to answer this question.');
  return answer.trim();
}

// One adapter covers OpenAI, Gemini, Grok, and Ollama - they all speak the
// Chat Completions dialect; only the base URL and key differ. Deliberately no
// max-token field (the compat layers disagree on max_tokens vs
// max_completion_tokens; ai.timeoutMs bounds runaways) and no cache_control
// (prompt caching is implicit on these providers).
async function askOpenAi(system, question, history, ai, provider, model, key, onDelta, signal) {
  const stream = typeof onDelta === 'function';
  const signals = [AbortSignal.timeout(ai.timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(endpointFor(provider, ai), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream,
      messages: [
        { role: 'system', content: system },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessage(body) ?? `${PROVIDERS[provider].label} returned ${res.status}`);
  }
  if (!stream) {
    const choice = (await res.json()).choices?.[0];
    if (choice?.message?.refusal) throw new Error('The model declined to answer this question.');
    return (choice?.message?.content ?? '').trim();
  }
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let answer = '';
  let refused = false;
  for await (const chunk of res.body) {
    for (const evt of parser.push(decoder.decode(chunk, { stream: true }))) {
      if (evt.error) throw new Error(errorMessage(evt) ?? 'stream error');
      if (evt.choices?.[0]?.delta?.refusal) refused = true;
      const text = openAiEventText(evt);
      if (text) {
        answer += text;
        onDelta(text);
      }
    }
  }
  // a refusal that still produced text keeps the text - the client saw it
  if (refused && !answer.trim()) throw new Error('The model declined to answer this question.');
  return answer.trim();
}

function askCli(system, question, history, ai, onDelta, signal) {
  const stream = typeof onDelta === 'function';
  return new Promise((resolve, reject) => {
    const args = stream
      ? ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
      : ['-p', '--output-format', 'text'];
    const cli = resolveCliInvocation(ai.cliCommand, args);
    const child = spawn(cli.file, cli.args, {
      ...cli.options,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let streamed = '';
    let resultText = null; // the result event's text is authoritative over deltas
    let model = null; // the init event names the model the CLI session runs
    const lines = stream ? createLineParser() : null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${ai.timeoutMs / 1000}s`));
    }, ai.timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (fn) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (d) => {
      const text = String(d);
      stdout += text;
      if (!lines) return;
      for (const evt of lines.push(text)) {
        if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.model === 'string') model = evt.model;
        if (evt.type === 'result' && typeof evt.result === 'string') resultText = evt.result;
        const t = cliEventText(evt);
        if (t) {
          streamed += t;
          onDelta(t);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      finish(() => reject(new Error(`could not run "${ai.cliCommand}" - install the Claude CLI or set an API key such as ANTHROPIC_API_KEY (${err.message})`)));
    });
    child.on('close', (code) => {
      finish(() => {
        if (signal?.aborted) return reject(new Error('cancelled'));
        const answer = (stream ? (resultText ?? streamed) : stdout).trim();
        if (code === 0 && answer) return resolve({ answer, model });
        // a CLI too old for the streaming flags gets one buffered retry
        if (stream && code !== 0 && /unknown|unrecognized|include-partial-messages/i.test(stderr)) {
          return resolve(askCli(system, question, history, ai, undefined, signal));
        }
        reject(new Error(stderr.trim() || `claude CLI exited with code ${code}`));
      });
    });

    const transcript = history
      .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
      .join('\n\n');
    child.stdin.write(
      `${system}\n\n---\n\n`
      + (transcript ? `Previous conversation:\n\n${transcript}\n\n---\n\n` : '')
      + `Question: ${question}\n`,
    );
    child.stdin.end();
  });
}
