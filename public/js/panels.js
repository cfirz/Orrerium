// Panel switcher for the topbar tabs. The active panel is stamped on
// <body data-panel> (panels read it to skip work while hidden), mirrored into
// the URL hash (#/name) so panels deep-link, and persisted across sessions.
// Order follows the nav: the observatory first, then the vault boards.
const PANELS = ['brain', 'agents', 'flows', 'stats', 'projects', 'inbox', 'icons'];

export function initPanels({ onShow }) {
  const buttons = [...document.querySelectorAll('.nav-btn')];

  function apply(name) {
    localStorage.setItem('orrerium.panel', name);
    document.body.dataset.panel = name;
    for (const b of buttons) {
      const on = b.dataset.panel === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
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
