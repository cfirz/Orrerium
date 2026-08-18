// Ask-your-brain: answers questions over the vault's notes with an LLM.
// Two providers, auto-detected:
//   api - raw HTTP against the Claude API (zero-dependency constraint rules
//         out the SDK; requires ANTHROPIC_API_KEY in the environment)
//   cli - spawns the local `claude` CLI, which uses the user's existing
//         Claude Code login (no API key needed)
import { spawn } from 'node:child_process';
import { resolveCliInvocation } from './cli-spawn.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export function resolveProvider(aiConfig) {
  if (aiConfig.provider === 'api' || aiConfig.provider === 'cli') return aiConfig.provider;
  return process.env.ANTHROPIC_API_KEY ? 'api' : 'cli';
}

// the whole vault fits comfortably in context - no retrieval step needed
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

export function buildSystem(context) {
  return `You are the librarian of a personal knowledge vault called the Brain. Answer the user's question using ONLY the vault notes below.

- Whenever you mention a note, cite it as a wikilink: [[note-id]]. These render as clickable links in the UI, so cite generously.
- Answer in concise markdown. Lead with the answer; keep it short unless depth is asked for.
- If the vault does not contain the answer, say so plainly - do not invent vault content.

<vault>
${context}
</vault>`;
}

export async function ask(question, { notes, skills, ai, history = [] }) {
  const provider = resolveProvider(ai);
  const system = buildSystem(buildContext(notes, skills));
  const answer = provider === 'api'
    ? await askApi(system, question, history, ai)
    : await askCli(system, question, history, ai);
  return { answer, provider, model: provider === 'api' ? ai.model : 'claude-cli default' };
}

async function askApi(system, question, history, ai) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ai.model,
      max_tokens: 16000,
      // cache the vault context so repeated questions only pay for the question
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.timeout(ai.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Claude API returned ${res.status}`);
  }
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

function askCli(system, question, history, ai) {
  return new Promise((resolve, reject) => {
    const cli = resolveCliInvocation(ai.cliCommand, ['-p', '--output-format', 'text']);
    const child = spawn(cli.file, cli.args, {
      ...cli.options,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${ai.timeoutMs / 1000}s`));
    }, ai.timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`could not run "${ai.cliCommand}" - install the Claude CLI or set ANTHROPIC_API_KEY (${err.message})`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `claude CLI exited with code ${code}`));
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
