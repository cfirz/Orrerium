// Graph view with two layouts:
//   rings - RUBRIC-style concentric orbits by type, core file at the center
//   force - Obsidian-style d3-force simulation
// Uses the global `d3` from the vendored bundle.
/* global d3 */

// Obsidian graph.json -> d3-force mapping (see vault .obsidian/graph.json, read-only reference)
const FORCES = {
  linkDistance: 250,
  charge: -300,
  chargeMaxDistance: 800,
  centerStrength: 0.05,
  collidePadding: 4,
  collideStrength: 0.7,
  sizeMultiplier: 1.3, // the single global size knob; NODE_SIZE is pre-multiplier
};

const REHEAT = { first: 1, topology: 0.3, content: 0.05 };

// concentric orbits, center -> out; the vault's core index file sits at (0,0).
// RUBRIC order: content in the middle, routines then applications outermost.
const CENTER_ID = 'README';

// Orbit radii are taken off the RUBRIC reference render, which puts the outermost
// orbit at 1.0 and everything else as a fraction of it. The proportion carries the
// look: a dense content band inside 0.6, then a wide empty gap out to ROUTINES and
// APPLICATIONS. Evenly-spaced orbits read as a dartboard instead.
const OUTER_RADIUS = 660;
const orbit = (f) => Math.round(f * OUTER_RADIUS);
const RINGS = [
  { type: 'root', radius: orbit(0.215), label: null },   // CONVENTIONS / CLAUDE / inbox
  { type: 'project', radius: orbit(0.29), label: null },
  { type: 'lesson', radius: orbit(0.375), label: null },
  { type: 'machine', radius: orbit(0.45), label: null },
  { type: 'idea', radius: orbit(0.515), label: null },
  { type: 'template', radius: orbit(0.57), label: null },
  { type: 'unresolved', radius: orbit(0.655), label: null }, // ghosts orbit the content
  { type: 'routine', radius: orbit(0.84), label: 'ROUTINES' },
  // cross-repo scan: agents/commands share one orbit between routines and
  // applications; repo anchors (repos without a vault project page) ride it too
  { type: 'repo', radius: orbit(0.93), label: null },
  { type: 'agent', radius: orbit(0.93), label: 'AGENTS' },
  { type: 'command', radius: orbit(0.93), label: null },
  { type: 'application', radius: orbit(1), label: 'APPLICATIONS' },
];
const FALLBACK_RADIUS = orbit(1.09); // unknown types, so nothing is ever lost off-canvas

// The content orbits carry no label of their own - seven arcs packed inside 0.6 collide
// with the very nodes they name. The reference labels the whole cloud MEMORY instead and
// leaves the sub-orbits to the colour legend, so one arc rides the empty annulus just
// outside the cloud. A band draws no guide circle: the reference has no stroke there.
const BANDS = [
  {
    name: 'memory',
    label: 'MEMORY',
    // 0.72, not the reference's 0.67: our ghost orbit is the band's outer edge at
    // 0.655, and its node labels hang below it
    radius: orbit(0.72),
    types: ['project', 'lesson', 'machine', 'idea', 'template', 'unresolved'],
  },
];

// Node radii, same reference, same ratios: as a fraction of the outermost orbit the
// center is .036, applications .030, projects .020, root .015, routines .012 and the
// whole content band .009. The content band has to stay that small or the inner
// orbits read as beads on a string rather than the cloud they are.
//
// base carries the size, deg only spreads it - `base` is tuned per type against that
// type's *median* degree, which is why the four content types differ slightly while
// rendering the same size. Retune base if a type's degree distribution shifts.
const NODE_SIZE = {
  center: { base: 13, deg: 1 },        // README, degree ~29
  root: { base: 5.25, deg: 1 },        // CONVENTIONS / CLAUDE / inbox, ~6
  project: { base: 6.8, deg: 1.2 },    // ~9
  lesson: { base: 2.9, deg: 0.7 },     // ~6
  machine: { base: 3, deg: 0.7 },      // ~5
  idea: { base: 3.6, deg: 0.7 },       // ~2
  template: { base: 3.85, deg: 0.7 },  // 0 - templates link to nothing
  routine: { base: 4.5, deg: 0.9 },    // ~4
  application: { base: 13.5, deg: 0.8 }, // ~3
  unresolved: { base: 3.45, deg: 0 },
  agent: { base: 4.5, deg: 0.9 },      // cross-repo scan; degree ~1 (repo anchor)
  command: { base: 3, deg: 0.7 },
  repo: { base: 6.8, deg: 1.2 },       // anchor for repos without a project page
};
const DEFAULT_SIZE = { base: 3, deg: 0.7 };

function radius(d) {
  const s = d.id === CENTER_ID ? NODE_SIZE.center : NODE_SIZE[d.type] ?? DEFAULT_SIZE;
  return (s.base + s.deg * Math.sqrt(d.degree)) * FORCES.sizeMultiplier;
}

// the companion dotted guide hugs its orbit proportionally, so the outer rings get
// a readable double line without the inner ones collapsing into one stroke
function guideInset(r) {
  return Math.max(10, r * 0.028);
}

// pointy-top hexagon for application nodes, RUBRIC-style
function hexagonPath(r) {
  const pts = d3.range(6).map((i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return `${r * Math.cos(a)},${r * Math.sin(a)}`;
  });
  return `M${pts.join('L')}Z`;
}

export function createGraphView({ svgEl, onSelect, getIcon }) {
  const svg = d3.select(svgEl);
  const viewport = svg.append('g').attr('class', 'viewport');
  const decoLayer = viewport.append('g').attr('class', 'deco');
  const edgeLayer = viewport.append('g');
  const hitLayer = viewport.append('g'); // invisible fat lines for edge hover
  // live agent traffic: above the edges so the dots are never hidden under one,
  // below the nodes so a dot slides under the blob on arrival (order = paint order)
  const sparkLayer = viewport.append('g').attr('class', 'sparks');
  const nodeLayer = viewport.append('g');
  const tooltipEl = document.getElementById('edge-tooltip');

  const posCache = new Map(); // id -> {x,y,vx,vy} - survives every data refresh (force mode)
  let nodes = [];
  let edges = [];
  let adjacency = new Map();
  let nodeSel = nodeLayer.selectAll('g.node');
  let edgeSel = edgeLayer.selectAll('line');
  let hitSel = hitLayer.selectAll('line');
  let sparkSel = sparkLayer.selectAll('line.spark');
  let edgeByKey = new Map();
  let activity = { nodes: new Map(), edges: new Map(), subagents: new Map() }; // from agent-activity.js
  let selectedId = null;
  let hoverId = null;
  let hoverEdgeKey = null;
  let searchSet = null;
  let topoKey = '';
  let firstLoad = true;
  let mode = 'rings';

  const sim = d3.forceSimulation()
    .force('link', d3.forceLink().id((d) => d.id).distance(FORCES.linkDistance))
    .force('charge', d3.forceManyBody().strength(FORCES.charge).distanceMax(FORCES.chargeMaxDistance))
    .force('x', d3.forceX(0).strength(FORCES.centerStrength))
    .force('y', d3.forceY(0).strength(FORCES.centerStrength))
    .force('collide', d3.forceCollide().radius((d) => radius(d) + FORCES.collidePadding).strength(FORCES.collideStrength))
    .on('tick', tick)
    .on('end', () => {
      if (firstLoad) { firstLoad = false; zoomToFit(); }
    });
  sim.stop();

  let userZoomed = false;
  const zoom = d3.zoom()
    .scaleExtent([0.15, 4])
    .on('zoom', (ev) => {
      if (ev.sourceEvent) userZoomed = true; // real gesture, not a programmatic fit
      viewport.attr('transform', ev.transform);
    });
  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', () => onSelect(null)); // background click clears selection

  centerViewport();

  // refit when the panel gains real size (hidden pane opened, window resized)
  new ResizeObserver(() => {
    if (!userZoomed && nodes.length > 0) zoomToFit(0);
  }).observe(svgEl);

  const drag = d3.drag()
    .filter((ev) => mode === 'force' && !ev.button) // orbits are baked; no dragging in rings
    .on('start', (ev, d) => {
      if (!ev.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on('end', (ev, d) => {
      if (!ev.active) sim.alphaTarget(0);
      d.fx = null; // Obsidian behaviour: nodes float free again after drag
      d.fy = null;
    });

  function update(data) {
    const prevTopo = topoKey;
    const rawEdges = data.edges;

    nodes = data.nodes.map((n) => ({ ...n, ...(posCache.get(n.id) ?? {}) }));
    const isNew = new Set(nodes.filter((n) => !posCache.has(n.id)).map((n) => n.id));
    for (const n of nodes) if (isNew.has(n.id)) seed(n, rawEdges);

    edges = rawEdges.map((e) => ({ ...e }));
    adjacency = buildAdjacency(data);
    topoKey = [
      data.nodes.map((n) => n.id).sort().join(','),
      rawEdges.map((e) => `${e.source}>${e.target}`).sort().join(','),
    ].join('|');

    sim.nodes(nodes);
    sim.force('link').links(edges); // also materialises edge endpoints as node refs
    edgeByKey = new Map(edges.map((e) => [edgeKey(e), e]));
    render();
    applyState();
    // sparks bind live edge objects, so a refresh must rebind them or they would
    // track the abandoned node objects and freeze where they stood
    renderSparks();
    renderNodeSparks();

    if (mode === 'rings') {
      sim.stop();
      applyRings(!firstLoad && !document.hidden);
      if (firstLoad) { firstLoad = false; zoomToFit(0); }
    } else {
      const alpha = firstLoad ? REHEAT.first : topoKey !== prevTopo ? REHEAT.topology : REHEAT.content;
      sim.alpha(alpha).restart();
    }
  }

  function setLayout(m) {
    if (m === mode) return;
    mode = m;
    userZoomed = false;
    if (nodes.length === 0) return;
    if (mode === 'rings') {
      sim.stop();
      applyRings(!document.hidden);
      zoomToFit(document.hidden ? 0 : 600);
    } else {
      svg.classed('rings-mode', false);
      decoLayer.style('display', 'none');
      sim.alpha(REHEAT.topology).restart(); // morph out of the orbits organically
      zoomToFit(document.hidden ? 0 : 600);
    }
  }

  // --- rings layout --------------------------------------------------------

  function applyRings(animate) {
    svg.classed('rings-mode', true);
    decoLayer.style('display', null);
    const pos = ringsLayout();
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
      posCache.set(n.id, { x: n.x, y: n.y, vx: 0, vy: 0 });
    }
    drawDeco();
    positionDom(animate);
  }

  function ringsLayout() {
    const pos = new Map();
    if (nodes.some((n) => n.id === CENTER_ID)) pos.set(CENTER_ID, { x: 0, y: 0 });

    const neighbours = new Map();
    for (const e of edges) {
      const s = idOf(e.source); const t = idOf(e.target);
      if (!neighbours.has(s)) neighbours.set(s, []);
      if (!neighbours.has(t)) neighbours.set(t, []);
      neighbours.get(s).push(t);
      neighbours.get(t).push(s);
    }

    const place = (members, r) => {
      if (members.length === 0) return;
      // preferred angle = direction of already-placed neighbours (skip the
      // center - everything links to it, it carries no direction)
      const pref = new Map();
      for (const n of members) {
        const anchors = (neighbours.get(n.id) ?? [])
          .filter((o) => o !== CENTER_ID)
          .map((o) => pos.get(o))
          .filter(Boolean);
        pref.set(n.id, anchors.length
          ? Math.atan2(d3.mean(anchors, (p) => p.y), d3.mean(anchors, (p) => p.x))
          : null);
      }
      members.sort((a, b) => {
        const pa = pref.get(a.id); const pb = pref.get(b.id);
        if (pa === null && pb === null) return a.id.localeCompare(b.id);
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      });
      const step = (2 * Math.PI) / members.length;
      const start = pref.get(members[0].id) ?? -Math.PI / 2;
      members.forEach((n, i) => {
        const a = start + i * step;
        pos.set(n.id, { x: r * Math.cos(a), y: r * Math.sin(a) });
      });
    };

    for (const ring of RINGS) {
      place(nodes.filter((n) => n.type === ring.type && n.id !== CENTER_ID), ring.radius);
    }
    place(nodes.filter((n) => !pos.has(n.id)), FALLBACK_RADIUS); // unknown types
    return pos;
  }

  function drawDeco() {
    decoLayer.selectAll('*').remove();

    const center = nodes.find((n) => n.id === CENTER_ID);
    if (center) {
      decoLayer.append('circle')
        .attr('class', 'center-ring')
        .attr('r', radius(center) + 12);
      decoLayer.append('circle')
        .attr('class', 'center-ring dotted')
        .attr('r', radius(center) + 22);
    }

    for (const ring of RINGS) {
      if (!nodes.some((n) => n.type === ring.type && n.id !== CENTER_ID)) continue;
      decoLayer.append('circle')
        .attr('class', `ring-guide ${ring.type}`)
        .attr('r', ring.radius);
      decoLayer.append('circle')
        .attr('class', `ring-guide dotted ${ring.type}`)
        .attr('r', ring.radius - guideInset(ring.radius));
      // label arc rides just inside its ring, over the top, as in the reference -
      // outside it, the outermost label pushes the whole fit out by a text height
      if (ring.label) arcLabel(ring.radius - 24, ring.label, `ring-label ${ring.type}`, ring.type);
    }

    for (const band of BANDS) {
      if (!nodes.some((n) => band.types.includes(n.type) && n.id !== CENTER_ID)) continue;
      arcLabel(band.radius, band.label, `ring-label band ${band.name}`, `band-${band.name}`);
    }
  }

  // an arc label riding over the top of the circle of radius r, centred at 12 o'clock
  function arcLabel(r, text, cls, key) {
    const k = r * Math.SQRT1_2;
    const pathId = `ring-path-${key}`;
    decoLayer.append('path')
      .attr('id', pathId)
      .attr('fill', 'none')
      .attr('d', `M ${-k} ${-k} A ${r} ${r} 0 0 1 ${k} ${-k}`);
    decoLayer.append('text')
      .attr('class', cls)
      .append('textPath')
      .attr('href', `#${pathId}`)
      .attr('startOffset', '50%')
      .attr('text-anchor', 'middle')
      .text(text);
  }

  function placeEnds(sel, dur) {
    (dur ? sel.transition().duration(dur) : sel)
      .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
  }

  function positionDom(animate) {
    const dur = animate ? 600 : 0;
    const nsel = dur ? nodeSel.transition().duration(dur) : nodeSel;
    nsel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    for (const sel of [edgeSel, hitSel, sparkSel]) placeEnds(sel, dur);
  }

  // --- force mode helpers --------------------------------------------------

  // place a brand-new node at an already-placed neighbour (plus jitter) so it
  // fades in next to its cluster instead of exploding the layout
  function seed(n, rawEdges) {
    const jitter = () => (Math.random() - 0.5) * 60;
    for (const e of rawEdges) {
      const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
      if (!other) continue;
      const p = posCache.get(other);
      if (p) { n.x = p.x + jitter(); n.y = p.y + jitter(); return; }
    }
    n.x = jitter() * 4;
    n.y = jitter() * 4;
  }

  function buildAdjacency(data) {
    const adj = new Map(data.nodes.map((n) => [n.id, new Set([n.id])]));
    for (const e of data.edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }
    return adj;
  }

  function render() {
    edgeSel = edgeLayer.selectAll('line')
      .data(edges, edgeKey)
      .join('line')
      .attr('class', (d) => `edge ${d.kind}`);

    hitSel = hitLayer.selectAll('line')
      .data(edges, edgeKey)
      .join('line')
      .attr('class', 'edge-hit')
      .on('mouseenter', (ev, d) => showEdgeTooltip(ev, d))
      .on('mousemove', (ev) => moveEdgeTooltip(ev))
      .on('mouseleave', () => hideEdgeTooltip());

    nodeSel = nodeLayer.selectAll('g.node')
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g');
        g.each(function (d) {
          const el = d3.select(this);
          if (d.type === 'application') {
            el.append('path').attr('class', 'shape');
            el.append('text').attr('class', 'glyph').attr('text-anchor', 'middle');
          } else {
            el.append('circle').attr('class', 'shape');
          }
        });
        g.append('text').attr('class', 'label').attr('text-anchor', 'middle');
        return g;
      })
      .attr('class', (d) => `node ${d.type}${d.id === CENTER_ID ? ' center' : ''}${d.disabled ? ' disabled' : ''}`)
      .call(drag)
      .on('mouseenter', (ev, d) => { hoverId = d.id; applyState(); })
      .on('mouseleave', () => { hoverId = null; applyState(); })
      .on('click', (ev, d) => { ev.stopPropagation(); onSelect(d.id); });

    nodeSel.select('circle.shape').attr('r', radius);
    nodeSel.select('path.shape').attr('d', (d) => hexagonPath(radius(d)));
    nodeSel.select('text.glyph')
      // inline style, not an attr - the stylesheet's font-size would win otherwise
      .style('font-size', (d) => `${(radius(d) * 0.95).toFixed(1)}px`)
      .text((d) => d.id[0].toUpperCase());
    nodeSel.select('text.label')
      .attr('y', (d) => radius(d) + 13)
      .text((d) => d.label ?? d.id); // scanned nodes carry namespaced ids, short labels

    // assigned pixel faces ride agent nodes, sized off the node radius
    nodeSel.select('g.node-icon').remove();
    if (getIcon) {
      nodeSel.filter((d) => d.type === 'agent').each(function (d) {
        const size = Math.round(radius(d) * 2.6);
        const svgStr = getIcon(d, size);
        if (!svgStr) return;
        d3.select(this).insert('g', 'text.label')
          .attr('class', 'node-icon')
          .attr('transform', `translate(${-size / 2},${-size / 2})`)
          .node().innerHTML = svgStr;
      });
    }
  }

  // --- live agent activity -------------------------------------------------
  // All motion is CSS keyframes (style.css); nothing here animates per frame.
  // A hidden pane pauses rAF, so d3 transitions and animationend never fire -
  // hence setTimeout for every removal, and never .transition().remove().

  const SPARK_SPEED = 0.09;     // user units per ms, ~90/s - pathLength normalises
  const SPARK_MIN_MS = 1200;    //   geometry but not velocity, so derive the duration
  const SPARK_MAX_MS = 6000;    //   from the edge length or short edges crawl
  const SPARK_FADE_MS = 500;
  const RIPPLE_MS = 900;
  // dash periods that divide 100 so the dashoffset 100->0 loop is seamless. The
  // dash itself is near-zero: under pathLength=100 a dash is a *percentage* of the
  // edge, so stroke-linecap:round + stroke-width must be what defines the dot.
  const SPARK_DASH = { 1: '0.6 99.4', 2: '0.6 49.4' };
  // a session radiating with nothing to attribute the work to drifts, so real
  // agent traffic still reads as the stronger signal on a crowded graph
  const AMBIENT_SLOWDOWN = 1.8;
  const ORBIT_DOTS = { 1: 3, 2: 5 };
  const ORBIT_DUR = { 1: '9s', 2: '5s' };
  // one dot per subagent in flight. Past a handful the ring stops being countable
  // and the honest reading is just "several", so cap it rather than crowd it.
  const MAX_SUBAGENT_DOTS = 8;
  const SUBAGENT_ORBIT_DUR = '14s';

  function edgeLength(d) {
    return Math.hypot(d.target.x - d.source.x, d.target.y - d.source.y);
  }

  function renderSparks() {
    const data = [...activity.edges.keys()].map((k) => edgeByKey.get(k)).filter(Boolean);
    sparkSel = sparkLayer.selectAll('line.spark:not(.dying)')
      .data(data, edgeKey)
      .join(
        (enter) => {
          const line = enter.append('line').attr('class', 'spark').attr('pathLength', 100);
          placeEnds(line, 0); // never sit at 0,0 for a frame
          return line;
        },
        (update) => update,
        (exit) => {
          // CSS fade + setTimeout: a d3 transition would never end in a hidden
          // pane, so .remove() would never fire and the lines would pile up
          const els = exit.classed('dying', true).nodes();
          setTimeout(() => { for (const el of els) el.remove(); }, SPARK_FADE_MS);
          return exit;
        },
      );
    sparkSel.each(function (d) {
      const a = activity.edges.get(edgeKey(d)) ?? {};
      const level = a.level ?? 1;
      // the slowdown scales the whole window, floor and ceiling included, so ambient
      // dots drift past SPARK_MAX_MS on long edges on purpose rather than by accident
      const scale = a.ambient ? AMBIENT_SLOWDOWN : 1;
      const dur = scale * Math.min(SPARK_MAX_MS, Math.max(SPARK_MIN_MS, edgeLength(d) / SPARK_SPEED));
      // custom properties and classes only: switching animation-name would restart
      // the animation and snap every dot back to the start of its edge
      d3.select(this)
        .classed('ambient', Boolean(a.ambient))
        .classed('reverse', Boolean(a.reverse))
        .style('--spark-dur', `${Math.round(dur)}ms`)
        .style('--spark-dash', a.ambient ? SPARK_DASH[1] : (SPARK_DASH[level] ?? SPARK_DASH[1]));
    });
  }

  // a symmetric ring of dots riding inside the node's own <g>, so it follows the
  // node for free. transform-box/origin are set in CSS - see the note there.
  // Rebuilt only when the dot count changes: re-appending the circles restarts the
  // CSS rotation and snaps the whole ring back to its start angle.
  function orbitRing(g, cls, count, r, dot) {
    let ring = g.select(`g.${cls}`);
    if (!count) { ring.remove(); return null; }
    if (ring.empty() || Number(ring.attr('data-dots')) !== count) {
      ring.remove();
      ring = g.insert('g', ':first-child') // behind the blob, so dots pass under it
        .attr('class', cls)
        .attr('data-dots', count);
      for (let i = 0; i < count; i += 1) {
        const a = (2 * Math.PI * i) / count - Math.PI / 2;
        ring.append('circle')
          .attr('cx', (r * Math.cos(a)).toFixed(2))
          .attr('cy', (r * Math.sin(a)).toFixed(2))
          .attr('r', dot);
      }
    }
    return ring;
  }

  function renderNodeSparks() {
    nodeSel.each(function (d) {
      const level = activity.nodes.get(d.id) ?? 0;
      const g = d3.select(this);
      orbitRing(g, 'node-spark', level ? ORBIT_DOTS[level] : 0, radius(d) + 6, 1.4)
        ?.style('--orbit-dur', ORBIT_DUR[level]);
      // A second, wider, counter-rotating ring carries one dot per working subagent,
      // so "how many agents are in flight" reads separately from "how recently did
      // this session speak" - which the single level ring cannot say at all.
      const subs = level ? Math.min(MAX_SUBAGENT_DOTS, activity.subagents?.get(d.id) ?? 0) : 0;
      orbitRing(g, 'subagent-spark', subs, radius(d) + 13, 2.1)
        ?.style('--orbit-dur', SUBAGENT_ORBIT_DUR);
    });
  }

  // one-shot ripple per event (spawn, or a burst of tool calls)
  function pulseNodes(ids) {
    const wanted = new Set(ids);
    nodeSel.filter((d) => wanted.has(d.id)).each(function (d) {
      const r = radius(d);
      const el = d3.select(this).insert('circle', ':first-child')
        .attr('class', 'ripple')
        .attr('r', r)
        .style('--ripple-from', `${r.toFixed(1)}px`)
        .style('--ripple-to', `${(r * 3 + 14).toFixed(1)}px`)
        .node();
      setTimeout(() => el.remove(), RIPPLE_MS); // not animationend - frozen in a hidden pane
    });
  }

  // --- edge tooltip --------------------------------------------------------

  function edgeKey(d) {
    return `${idOf(d.source)}>${idOf(d.target)}`;
  }

  const KIND_LABEL = { frontmatter: 'frontmatter link', body: 'prose link', tag: 'tag link', scan: 'workspace link' };

  function showEdgeTooltip(ev, d) {
    hoverEdgeKey = edgeKey(d);
    applyState();
    if (!tooltipEl) return;
    const count = d.count > 1 ? ` ×${d.count}` : '';
    tooltipEl.textContent = `${idOf(d.source)} ↔ ${idOf(d.target)} · ${KIND_LABEL[d.kind] ?? d.kind}${count}`;
    tooltipEl.classList.remove('hidden');
    moveEdgeTooltip(ev);
  }

  function moveEdgeTooltip(ev) {
    if (!tooltipEl) return;
    const rect = svgEl.getBoundingClientRect();
    tooltipEl.style.left = `${ev.clientX - rect.left + 14}px`;
    tooltipEl.style.top = `${ev.clientY - rect.top + 14}px`;
  }

  function hideEdgeTooltip() {
    hoverEdgeKey = null;
    applyState();
    if (tooltipEl) tooltipEl.classList.add('hidden');
  }

  function edgeFaded(d, focus) {
    if (!focus) return false;
    if (searchSet) return !(focus.has(idOf(d.source)) && focus.has(idOf(d.target)));
    return idOf(d.source) !== hoverId && idOf(d.target) !== hoverId;
  }

  // one place decides fading/selection so hover, search and selection never fight
  function applyState() {
    const focus = searchSet ?? (hoverId ? adjacency.get(hoverId) : null);
    nodeSel
      .classed('faded', (d) => (focus ? !focus.has(d.id) : false))
      .classed('selected', (d) => d.id === selectedId)
      .classed('live', (d) => activity.nodes.has(d.id));
    sparkSel.classed('faded', (d) => edgeFaded(d, focus)); // same predicate, harder fade
    edgeSel
      .classed('faded', (d) => edgeFaded(d, focus))
      .classed('lit', (d) => {
        if (edgeKey(d) === hoverEdgeKey) return true; // direct edge hover
        if (searchSet || !hoverId) return false;
        return idOf(d.source) === hoverId || idOf(d.target) === hoverId; // the fan
      });
  }

  function tick() {
    if (mode !== 'force') return;
    positionDom(false);
    for (const n of nodes) posCache.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
  }

  // --- viewport ------------------------------------------------------------

  // the panel can be 0x0 while the pane is hidden - fall back and refit later
  function panelSize() {
    const r = svgEl.getBoundingClientRect();
    return {
      width: r.width || window.innerWidth || 960,
      height: r.height || window.innerHeight || 600,
    };
  }

  function centerViewport() {
    const { width, height } = panelSize();
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));
  }

  function zoomToFit(duration = 400) {
    if (nodes.length === 0) return;
    const { width, height } = panelSize();
    let x0; let x1; let y0; let y1;
    if (mode === 'rings') {
      // fit the outermost occupied orbit, not just nodes; the headroom is for the
      // node sitting ON that orbit plus its label, since the ring labels are inside
      const occupied = RINGS.filter((r) => nodes.some((n) => n.type === r.type && n.id !== CENTER_ID));
      const R = (occupied.length ? Math.max(...occupied.map((r) => r.radius)) : FALLBACK_RADIUS) + 45;
      x0 = -R; x1 = R; y0 = -R; y1 = R;
    } else {
      const xs = nodes.map((n) => n.x);
      const ys = nodes.map((n) => n.y);
      x0 = Math.min(...xs); x1 = Math.max(...xs);
      y0 = Math.min(...ys); y1 = Math.max(...ys);
    }
    const pad = 60;
    const scale = Math.min(
      2,
      0.95 * Math.min(width / (x1 - x0 + pad * 2 || 1), height / (y1 - y0 + pad * 2 || 1)),
    );
    const t = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    // duration 0 must apply synchronously - transitions depend on rAF, which
    // pauses while the pane is hidden
    (duration ? svg.transition().duration(duration) : svg).call(zoom.transform, t);
  }

  function focusNode(id, scale = 1.5) {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const { width, height } = panelSize();
    const t = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-n.x, -n.y);
    svg.transition().duration(400).call(zoom.transform, t);
  }

  return {
    update,
    zoomToFit,
    focusNode,
    setLayout,
    getLayout() { return mode; },
    setSelected(id) { selectedId = id; applyState(); },
    setSearchResults(idSet) { searchSet = idSet; applyState(); },
    // live agent activity - the view stays ignorant of sessions and who spawned
    // what, it only receives {nodes: Map<id,level>, edges: Map<key,{level}>,
    // subagents: Map<id,count>}
    setAgentActivity(act) {
      activity = act;
      renderSparks();
      renderNodeSparks();
      applyState();
    },
    pulseNodes,
    hasNode(id) { return nodes.some((n) => n.id === id); },
    sim, // exposed for console/agent inspection
  };
}

function idOf(end) {
  return typeof end === 'object' ? end.id : end;
}
