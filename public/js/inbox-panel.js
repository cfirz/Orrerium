// Inbox triage view: renders inbox.md's capture buffer as cards and flags
// when it reaches the vault's ~5-entry triage threshold (the capture and triage
// skills use the same number). The entry count also rides on the topbar nav
// button, so it is kept fresh while hidden.
import { renderMarkdown } from './md.js';

const TRIAGE_ENTRIES = 5;

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

  list.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
    }
  });
  head.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
    }
  });

  async function refresh() {
    const res = await fetch('/api/note/inbox');
    if (!res.ok) {
      head.innerHTML = '<h1>INBOX</h1><div class="board-sub">no inbox.md in this vault</div>';
      list.innerHTML = '';
      setCount(0, false);
      return;
    }
    const note = await res.json();
    // strip the header comment; entries are the remaining paragraph blocks
    const body = note.markdown.replace(/<!--[\s\S]*?-->/, '');
    const entries = body
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^#\s/.test(s));
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
