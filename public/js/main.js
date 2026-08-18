import { createGraphView } from './graph-view.js';
import { createNotePanel } from './note-panel.js';
import { initSearch } from './search.js';
import { initAskPanel } from './ask-panel.js';
import { initAskHistory } from './ask-history.js';
import { initPanels } from './panels.js';
import { createProjectsPanel } from './projects-panel.js';
import { createInboxPanel } from './inbox-panel.js';
import { createAgentsPanel } from './agents-panel.js';
import { createFlowsPanel } from './flows-panel.js';
import { createIconsPanel } from './icons-panel.js';
import { createCronsPanel } from './crons-panel.js';
import { createStatsPanel } from './stats-panel.js';
import { renderIcon } from './icons.js';
import { createAgentActivity } from './agent-activity.js';
import { on as busOn, onStatus } from './bus.js';

const LEGEND = [
  ['project', 'projects'],
  ['lesson', 'lessons'],
  ['machine', 'machine'],
  ['idea', 'ideas'],
  ['template', 'templates'],
  ['root', 'root docs'],
  ['routine', 'routines'],
  ['agent', 'agents'],
  ['command', 'commands'],
  ['application', 'applications'],
];

let graphData = null;
let selectedId = null;
let iconAssignments = {}; // agent node id -> icon name, mirrored from /api/icons

// exact id first, then any repo's agent of that type (board rows only know the type)
function iconSvgFor(id, type, size) {
  let name = iconAssignments[id];
  if (!name && type) {
    const key = Object.keys(iconAssignments).find((k) => k.endsWith(`.${type}`));
    if (key) name = iconAssignments[key];
  }
  return name ? renderIcon(name, size) : null;
}

const panelEl = document.getElementById('note-panel');

const view = createGraphView({
  svgEl: document.getElementById('graph'),
  onSelect: (id) => selectNode(id),
  getIcon: (d, size) => iconSvgFor(d.id, null, size),
});

const notePanel = createNotePanel({
  el: panelEl,
  onNavigate: (slug) => selectNode(slug, { focus: true }),
  onClose: () => selectNode(null),
  hasNote: (slug) => Boolean(graphData?.nodes.some((n) => n.id === slug && n.type !== 'unresolved')),
  getEdges: () => graphData?.edges ?? [],
});

const search = initSearch({
  input: document.getElementById('search'),
  countEl: document.getElementById('search-count'),
  view,
  getGraphData: () => graphData,
  onPick: (id) => selectNode(id, { focus: true }),
});

const askPanel = initAskPanel({
  onNavigate: (slug) => selectNode(slug, { focus: true }),
});
initAskHistory({ onRestore: (conv) => askPanel.restore(conv) });

// --- dashboard panels -----------------------------------------------------

function openInGraph(id) {
  panels.show('brain');
  selectNode(id, { focus: true });
}

const projectsPanel = createProjectsPanel({ onOpen: openInGraph });
const inboxPanel = createInboxPanel({ onNavigate: openInGraph });
const agentsPanel = createAgentsPanel({
  getIcon: (project, type, size) => iconSvgFor(`${project}.${type}`, type, size),
});
const flowsPanel = createFlowsPanel();
const iconsPanel = createIconsPanel({ getGraphData: () => graphData });
const cronsPanel = createCronsPanel();
const statsPanel = createStatsPanel();
const panels = initPanels({
  onShow: (name) => {
    if (name === 'inbox') inboxPanel.refresh();
    if (name === 'agents') agentsPanel.refresh();
    if (name === 'flows') flowsPanel.refresh();
    if (name === 'icons') iconsPanel.refresh();
    if (name === 'crons') cronsPanel.refresh();
    if (name === 'stats') statsPanel.refresh();
  },
});
const agentActivity = createAgentActivity({ view, getGraphData: () => graphData });

busOn('crons', (data) => {
  cronsPanel.onCrons(data);
  statsPanel.onCrons();
});
busOn('agents', (snapshot) => {
  agentsPanel.render(snapshot);
  flowsPanel.onAgents();
  statsPanel.onAgents();
  agentActivity.onSnapshot(snapshot); // light up the live nodes in the graph
});
busOn('icons', ({ assignments }) => {
  iconAssignments = assignments;
  iconsPanel.setAssignments(assignments);
  if (graphData) view.update(graphData); // repaint agent nodes with their faces
  agentsPanel.refresh();
});
fetch('/api/icons').then((r) => (r.ok ? r.json() : null)).then((data) => {
  if (!data) return;
  iconAssignments = data.assignments;
  if (graphData) view.update(graphData);
});
// SSE only pushes on a *new* hook event, so a reload mid-session would show a dead
// graph until the next tool call - seed the activity from the current snapshot
fetch('/api/agents').then((r) => (r.ok ? r.json() : null)).then((snapshot) => {
  if (snapshot) agentActivity.onSnapshot(snapshot);
});

function selectNode(id, opts = {}) {
  selectedId = id;
  view.setSelected(id);
  if (id) {
    panelEl.classList.remove('hidden');
    const node = graphData?.nodes.find((n) => n.id === id);
    if (node?.type === 'application') notePanel.showApplication(node, graphData.nodes);
    else notePanel.show(id);
    if (opts.focus) view.focusNode(id);
  } else {
    panelEl.classList.add('hidden');
    notePanel.clear();
  }
}

async function loadGraph() {
  const res = await fetch('/api/graph');
  graphData = await res.json();
  view.update(graphData);
  search.reapply();
  projectsPanel.render(graphData);
  iconsPanel.rerender(); // its agent list reads the graph
  agentActivity.reapply(); // node ids may have changed under the live set
  return graphData;
}

function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = LEGEND
    .map(([type, label]) => `<div><span class="swatch" style="background: var(--c-${type})"></span>${label}</div>`)
    .join('');
}

// --- live reload ----------------------------------------------------------

function connectEvents() {
  const dot = document.getElementById('status-dot');
  let firstOpen = true;

  busOn('vault', async ({ files }) => {
    await loadGraph();
    // if the open note is among the changed files, silently refresh it
    const cur = notePanel.currentId;
    if (cur && files.some((f) => f === `${cur}.md` || f.endsWith(`/${cur}.md`))) {
      notePanel.show(cur);
    }
    if (files.includes('inbox.md')) inboxPanel.refresh();
  });
  onStatus((connected) => {
    dot.classList.toggle('live', connected);
    dot.classList.toggle('down', !connected);
    dot.title = connected ? 'live - watching the vault' : 'disconnected - retrying';
    // a reconnect may have missed events; refetch (initial load already did)
    if (connected && !firstOpen) loadGraph();
    if (connected) firstOpen = false;
  });
}

// --- layout toggle --------------------------------------------------------

const layoutBtns = [...document.querySelectorAll('#layout-toggle .seg-btn')];

function setLayout(m) {
  localStorage.setItem('orrerium.layout', m);
  for (const b of layoutBtns) b.classList.toggle('active', b.dataset.layout === m);
  view.setLayout(m);
}

for (const b of layoutBtns) b.addEventListener('click', () => setLayout(b.dataset.layout));
{
  const saved = localStorage.getItem('orrerium.layout');
  const initial = saved === 'force' || saved === 'rings' ? saved : 'rings';
  for (const b of layoutBtns) b.classList.toggle('active', b.dataset.layout === initial);
  view.setLayout(initial); // no data yet - just sets the mode before first load
}

// --- motion toggle --------------------------------------------------------

// Motion defaults to "full" so a first run shows live traffic everywhere: the
// sparks ARE the live-activity read-out, not decoration on top of it. The toggle
// is only rendered when the browser reports prefers-reduced-motion: reduce, since
// that is the only case where picking Auto changes anything. See the note above
// the guard in style.css for why this feature gets an escape hatch that ordinary
// decoration would not.
{
  const wrap = document.getElementById('motion-toggle');
  const btns = [...wrap.querySelectorAll('.seg-btn')];

  function setMotion(m) {
    localStorage.setItem('orrerium.motion', m);
    document.documentElement.dataset.motion = m;
    for (const b of btns) b.classList.toggle('active', b.dataset.motion === m);
  }

  for (const b of btns) b.addEventListener('click', () => setMotion(b.dataset.motion));

  const saved = localStorage.getItem('orrerium.motion');
  setMotion(saved === 'auto' ? 'auto' : 'full'); // default On; only an explicit Auto opts out
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) wrap.setAttribute('data-relevant', '');
}

buildLegend();
loadGraph();
connectEvents();

// console/agent-inspectable handle (RUBRIC ethos: the dashboard is debuggable from outside)
window.orrerium = {
  view,
  agentActivity,
  selectNode,
  loadGraph,
  get graphData() { return graphData; },
  get selectedId() { return selectedId; },
};

export { view, selectNode, loadGraph };
