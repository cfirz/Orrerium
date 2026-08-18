// Ask-your-brain: floating input over the graph; a multi-turn conversation
// whose answers render as markdown and whose [[wikilinks]] navigate the graph.
import { renderMarkdown, escapeHtml } from './md.js';

export function initAskPanel({ onNavigate }) {
  const form = document.getElementById('ask-form');
  const input = document.getElementById('ask-input');
  const stopBtn = document.getElementById('ask-stop');
  const card = document.getElementById('ask-answer');
  const thread = document.getElementById('ask-answer-body');
  const meta = document.getElementById('ask-meta');
  let history = []; // {role, content} pairs sent back with every question
  let conversationId = null; // server-issued id; carried so history persists
  let pending = false;
  let controller = null; // aborts the in-flight ask; server cancels the provider

  stopBtn.addEventListener('click', () => controller?.abort());

  card.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
      return;
    }
    if (ev.target.closest('.clear-btn')) clear();
    else if (ev.target.closest('.close-btn')) hide();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      hide();
      input.blur();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const question = input.value.trim();
    if (!question || pending) return;
    pending = true;
    input.disabled = true;
    input.value = '';
    controller = new AbortController();
    stopBtn.classList.remove('hidden');
    show();

    const qEl = document.createElement('div');
    qEl.className = 'ask-q';
    qEl.textContent = question;
    thread.appendChild(qEl);
    const aEl = document.createElement('div');
    aEl.className = 'ask-a note-body';
    aEl.innerHTML = '<div class="ask-thinking">thinking<span>.</span><span>.</span><span>.</span></div>';
    thread.appendChild(aEl);
    scrollToEnd();

    let answer = '';
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history, conversationId, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `request failed (${res.status})`);
      }
      // NDJSON stream: meta, delta lines while the answer generates, then
      // done (authoritative full text) or error. Render once per network
      // batch, not per delta line, and only follow the scroll while the
      // reader is already at the bottom.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let data = null;
      while (true) {
        const { value, done: eof } = await reader.read();
        buf += decoder.decode(value ?? new Uint8Array(), { stream: !eof });
        const lines = buf.split('\n');
        buf = eof ? '' : lines.pop();
        let grew = false;
        for (const l of lines) {
          if (!l.trim()) continue;
          const evt = JSON.parse(l);
          if (evt.type === 'delta') { answer += evt.text; grew = true; }
          else if (evt.type === 'done') data = evt;
          else if (evt.type === 'error') throw new Error(evt.error);
        }
        if (grew && !data) {
          const follow = card.scrollHeight - card.scrollTop - card.clientHeight < 48;
          aEl.innerHTML = renderMarkdown(answer);
          if (follow) scrollToEnd();
        }
        if (eof) break;
      }
      if (!data) throw new Error('the answer stream ended early');
      aEl.innerHTML = renderMarkdown(data.answer);
      // always adopt: a server that pruned/lost the id issues a fresh one
      conversationId = data.conversationId ?? conversationId;
      history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
      meta.textContent = `answered via ${data.model} · follow-ups keep context`;
    } catch (err) {
      if (err.name === 'AbortError') {
        // stopped by the user: keep whatever streamed in, drop the turn -
        // it rides in neither client history nor the server's record
        aEl.innerHTML = (answer ? renderMarkdown(answer) : '') + '<div class="ask-stopped">stopped</div>';
        meta.textContent = 'stopped — this turn was not kept';
      } else {
        aEl.innerHTML = `<div class="ask-error">${escapeHtml(err.message)}</div>`;
      }
    } finally {
      pending = false;
      controller = null;
      stopBtn.classList.add('hidden');
      input.disabled = false;
      input.focus();
      scrollToEnd();
    }
  });

  function scrollToEnd() { card.scrollTop = card.scrollHeight; }
  function show() { card.classList.remove('hidden'); }
  function hide() { card.classList.add('hidden'); }
  function clear() {
    // starts a new conversation; the old one stays in the history menu
    history = [];
    conversationId = null;
    thread.innerHTML = '';
    meta.textContent = '';
    hide();
    input.focus();
  }

  function restore(conv) {
    conversationId = conv.id;
    history = conv.turns.map(({ role, content }) => ({ role, content }));
    thread.innerHTML = '';
    for (const t of conv.turns) {
      const el = document.createElement('div');
      if (t.role === 'user') {
        el.className = 'ask-q';
        el.textContent = t.content;
      } else {
        el.className = 'ask-a note-body';
        el.innerHTML = renderMarkdown(t.content);
      }
      thread.appendChild(el);
    }
    meta.textContent = 'restored · follow-ups keep context';
    show();
    scrollToEnd();
    input.focus();
  }

  return { restore };
}
