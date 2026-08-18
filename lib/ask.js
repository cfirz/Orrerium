// Ask-your-brain: answers questions over the vault's notes with an LLM.
// Two providers, auto-detected:
//   api - raw HTTP against the Claude API (zero-dependency constraint rules
//         out the SDK; requires ANTHROPIC_API_KEY in the environment)
//   cli - spawns the local `claude` CLI, which uses the user's existing
//         Claude Code login (no API key needed)
// Both stream: pass onDelta to receive answer text as it is generated (the
// API via SSE, the CLI via --output-format stream-json); without onDelta the
// providers make their original buffered calls.
import { spawn } from 'node:child_process';
import { resolveCliInvocation } from './cli-spawn.js';
import { estimateTokens, selectContext } from './retrieve.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export function resolveProvider(aiConfig) {
  if (aiConfig.provider === 'api' || aiConfig.provider === 'cli') return aiConfig.provider;
  return process.env.ANTHROPIC_API_KEY ? 'api' : 'cli';
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
  if (provider === 'api') {
    const answer = await askApi(system, question, history, ai, onDelta, signal);
    return { answer, provider, model: ai.model };
  }
  const { answer, model } = await askCli(system, question, history, ai, onDelta, signal);
  return { answer, provider, model: model ?? 'claude-cli default' };
}

async function askApi(system, question, history, ai, onDelta, signal) {
  const stream = typeof onDelta === 'function';
  const signals = [AbortSignal.timeout(ai.timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(ai.apiUrl ?? API_URL, { // ai.apiUrl: test seam only
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ai.model,
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
    throw new Error(body?.error?.message ?? `Claude API returned ${res.status}`);
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
      finish(() => reject(new Error(`could not run "${ai.cliCommand}" - install the Claude CLI or set ANTHROPIC_API_KEY (${err.message})`)));
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
