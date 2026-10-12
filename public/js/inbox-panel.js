// Inbox triage view: renders inbox.md's capture buffer as cards and flags
// when it reaches the vault's ~5-entry triage threshold (the capture and triage
// skills use the same number). The entry count also rides on the topbar nav
// button, so it is kept fresh while hidden.
import { renderMarkdown } from './md.js';
import { TRIAGE_ENTRIES, inboxEntries } from './inbox-count.js';

export function createInboxPanel({ onNavigate }) {
  const head = document.getElementById('inbox-head');
  const list = document.getElementById('inbox-entries');
  const count = document.getElementById('inbox-count');

  function setCount(n, ready) {
    count.hidden = n === 0;
    count.textContent = String(n);
    count.classList.toggle('ready', ready);
    count.title = `${n} capture${n === 1 ? '' : 's'} waiting${ready ? ' - ready for triage' : ''}`;
  }

  // wikilinks in the header hint and in the entries navigate the graph
  const navigate = (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
    }
  };
  list.addEventListener('click', navigate);
  head.addEventListener('click', navigate);

  async function refresh() {
    const res = await fetch('/api/note/inbox');
    if (!res.ok) {
      head.innerHTML = '<h1>INBOX</h1><div class="board-sub">no inbox.md in this vault</div>';
      list.innerHTML = '';
      setCount(0, false);
      return;
    }
    const note = await res.json();
    const entries = inboxEntries(note.markdown);
    const ready = entries.length >= TRIAGE_ENTRIES;
    setCount(entries.length, ready);

    head.innerHTML = `
      <h1>INBOX</h1>
      <div class="board-sub">${entries.length} capture${entries.length === 1 ? '' : 's'}${ready ? ' · <span class="ready">ready for triage</span>' : ''}</div>
      <div class="board-hint">Append-only capture buffer. The <a class="wikilink" data-slug="capture">capture</a> routine writes here;
      <a class="wikilink" data-slug="triage">triage</a> promotes entries into real notes once it holds ~${TRIAGE_ENTRIES} entries.</div>`;

    list.innerHTML = entries
      .map((e) => `<div class="inbox-entry note-body">${renderMarkdown(e)}</div>`)
      .join('');
  }

  return { refresh };
}
