// Search box: substring filter over id/description/tags, shares the graph's
// .faded treatment, Enter focuses the best match, Escape clears.
export function initSearch({ input, countEl, view, getGraphData, onPick }) {
  input.addEventListener('input', apply);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') pick();
    else if (ev.key === 'Escape') {
      input.value = '';
      apply();
      input.blur();
    }
  });

  function query() {
    return input.value.trim().toLowerCase();
  }

  function matches() {
    const q = query();
    if (!q) return null;
    const data = getGraphData();
    if (!data) return null;
    return new Set(
      data.nodes
        .filter((n) => n.id.toLowerCase().includes(q)
          || (n.description ?? '').toLowerCase().includes(q)
          || n.tags.some((t) => String(t).toLowerCase().includes(q)))
        .map((n) => n.id),
    );
  }

  function apply() {
    const m = matches();
    view.setSearchResults(m);
    const data = getGraphData();
    countEl.textContent = m && data ? `${m.size}/${data.nodes.length}` : '';
  }

  function pick() {
    const m = matches();
    if (!m || m.size === 0) return;
    const q = query();
    const exact = [...m].find((id) => id.toLowerCase() === q);
    onPick(exact ?? [...m][0]);
  }

  // graph data changed (live reload) - recompute the fade set and count
  return { reapply: apply };
}
