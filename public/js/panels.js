// Panel switcher: Brain (graph), Projects (board), Inbox (triage view).
// The active panel is stamped on <body data-panel> so CSS can scope the
// topbar controls, mirrored into the URL hash (#/name) so panels deep-link,
// and persisted across sessions.
const PANELS = ['brain', 'projects', 'agents', 'flows', 'icons', 'crons', 'stats', 'inbox'];

export function initPanels({ onShow }) {
  const buttons = [...document.querySelectorAll('.nav-btn')];

  function apply(name) {
    localStorage.setItem('orrerium.panel', name);
    document.body.dataset.panel = name;
    for (const b of buttons) b.classList.toggle('active', b.dataset.panel === name);
    for (const sec of document.querySelectorAll('.panel-section')) {
      sec.classList.toggle('hidden', sec.id !== `panel-${name}`);
    }
    onShow?.(name);
  }

  function show(name) {
    // replaceState, not location.hash: no history spam, no scroll jump
    history.replaceState(null, '', `#/${name}`);
    apply(name);
  }

  function fromHash() {
    const m = /^#\/([a-z-]+)/.exec(location.hash);
    return m && PANELS.includes(m[1]) ? m[1] : null;
  }

  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.panel));
  window.addEventListener('hashchange', () => {
    const name = fromHash();
    if (name && name !== document.body.dataset.panel) apply(name);
  });

  const saved = localStorage.getItem('orrerium.panel');
  show(fromHash() ?? (PANELS.includes(saved) ? saved : 'brain'));

  return { show };
}
