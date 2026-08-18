// Ask-your-brain conversation history: one JSON document under data/ that is
// mutated in place (turns appended, updatedAt bumped) - the crons.json
// read-mutate-rewrite shape, not an NDJSON event log. The server records
// every answered turn; the client only carries the conversation id.
import path from 'node:path';
import { readJson, writeJson } from './store.js';

const TITLE_CHARS = 80;

export function createAskHistory({ dataDir, now = Date.now, maxConversations = 100 }) {
  const FILE = path.join(dataDir, 'ask-conversations.json');

  let conversations = readJson(FILE, []);

  function record({ id, history = [], question, answer, provider, model }) {
    const ts = now();
    let conv = id ? conversations.find((c) => c.id === id) : null;
    if (conv) {
      conv.turns.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      conv.updatedAt = ts;
      conv.provider = provider;
      conv.model = model;
    } else {
      // unknown id (pruned or deleted file, fresh server): rebuild the whole
      // thread from the history the client sent along with this turn
      const turns = [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ];
      const first = turns.find((t) => t.role === 'user');
      conv = {
        id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: ts,
        updatedAt: ts,
        title: (first?.content ?? question).trim().slice(0, TITLE_CHARS),
        turns,
        provider,
        model,
      };
      conversations.push(conv);
    }
    if (conversations.length > maxConversations) {
      conversations.sort((a, b) => a.updatedAt - b.updatedAt);
      conversations = conversations.slice(conversations.length - maxConversations);
    }
    writeJson(FILE, conversations);
    return conv;
  }

  function list() {
    return [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, startedAt, updatedAt, turns, provider, model }) => (
        { id, title, startedAt, updatedAt, turnCount: turns.length, provider, model }
      ));
  }

  function get(id) {
    return conversations.find((c) => c.id === id) ?? null;
  }

  function remove(id) {
    conversations = conversations.filter((c) => c.id !== id);
    writeJson(FILE, conversations);
    return list();
  }

  return { record, list, get, remove };
}
