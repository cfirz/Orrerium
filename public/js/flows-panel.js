// Flows: replayable timeline of a session's multi-agent run. Lane 0 is the
// orchestrator (tool ticks, prompt marks); subagent spans stack above it.
// Playback advances via setInterval, never rAF - a hidden pane pauses rAF
// and the scrubber must stay verifiable headlessly.
// The lib pre-segments idle gaps; makeScale collapses each break to BREAK_PX
// so activity stays readable and the scrubber runs in active time, meaning
// replay and scrubbing skip idle stretches instantly.
/* global d3 */
import { escapeHtml } from './md.js';
import { fmtDur } from './fmt.js';

const LANE_H = 34;
const MARGIN = { top: 26, right: 24, bottom: 26, left: 110 };
const PLAY_TICK_MS = 100;
const PLAY_SECONDS = 8; // a full replay takes ~8s regardless of session length
const BREAK_PX = 28; // collapsed width of one idle gap
const MIN_BAR = 6;
// round durations the axis may tick at, in ms: 1s..30s, 1m..30m, 1h..24h
const TICK_STEPS = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200, 86400,
].map((s) => s * 1000);

// stable per-type colour without a palette dependency
function typeColor(type) {
  let h = 0;
  for (const c of type) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 62%)`;
}

// piecewise-linear time -> pixel mapping over the flow's active segments,
// each break collapsed to BREAK_PX. Strictly monotonic, so a span straddling
// a gap still draws with a sane (compressed) width across the break marker.
function makeScale(flow, x0, x1) {
  const { segments, breaks } = flow;
  const activeMs = Math.max(1, flow.activeMs);
  const drawable = Math.max(1, (x1 - x0) - BREAK_PX * breaks.length);
  const pxPerMs = drawable / activeMs;
  const px0 = segments.map((seg, i) => x0 + seg.vStart * pxPerMs + BREAK_PX * i);

  function x(t) {
    const c = Math.min(Math.max(t, flow.start), flow.end);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (c > seg.end) continue;
      if (c >= seg.start) return px0[i] + (c - seg.start) * pxPerMs;
      // inside the gap before this segment: interpolate across the break
      const gap = breaks[i - 1];
      return px0[i] - BREAK_PX + ((c - gap.at) / gap.skippedMs) * BREAK_PX;
    }
    const last = segments.length - 1;
    return px0[last] + (segments[last].end - segments[last].start) * pxPerMs;
  }

  // scrub fraction <-> timestamp, in active-time space
  function fracToTime(f) {
    const a = Math.min(Math.max(f, 0), 1) * flow.activeMs;
    for (const seg of segments) {
      if (a <= seg.vEnd) return seg.start + Math.max(0, a - seg.vStart);
    }
    return flow.end;
  }

  function timeToFrac(t) {
    const c = Math.min(Math.max(t, flow.start), flow.end);
    for (const seg of segments) {
      if (c > seg.end) continue;
      // gap interiors snap back to the preceding segment's end
      const a = c >= seg.start ? seg.vStart + (c - seg.start) : seg.vStart;
      return Math.min(1, a / activeMs);
    }
    return 1;
  }

  return { x, fracToTime, timeToFrac };
}

export function createFlowsPanel() {
  const head = document.getElementById('flows-head');
  const select = document.getElementById('flows-select');
  const playBtn = document.getElementById('flows-play');
  const scrubEl = document.getElementById('flows-scrub');
  const svgEl = document.getElementById('flows-svg');
  const detail = document.getElementById('flows-detail');

  let sessions = [];
  let current = null; // sessionId
  let flow = null;
  let scale = null; // set by draw(), read by applyScrub()/load()
  let loadSeq = 0; // stale-response guard: only the latest load may land
  let playTimer = null;
  let liveTimer = null;

  select.addEventListener('change', () => load(select.value));
  scrubEl.addEventListener('input', () => { stopPlay(); applyScrub(); });
  playBtn.addEventListener('click', () => (playTimer ? stopPlay() : startPlay()));

  function scrubT() {
    return Number(scrubEl.value) / Number(scrubEl.max);
  }

  function startPlay() {
    if (!flow) return;
    if (scrubT() >= 1) scrubEl.value = 0;
    playBtn.textContent = '⏸';
    const step = Number(scrubEl.max) / ((PLAY_SECONDS * 1000) / PLAY_TICK_MS);
    playTimer = setInterval(() => {
      scrubEl.value = Math.min(Number(scrubEl.max), Number(scrubEl.value) + step);
      applyScrub();
      if (scrubT() >= 1) stopPlay();
    }, PLAY_TICK_MS);
  }

  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = '▶';
  }

  async function refresh() {
    const res = await fetch('/api/flows');
    if (!res.ok) return;
    sessions = (await res.json()).sessions;
    head.innerHTML = `
      <h1>FLOWS</h1>
      <div class="board-sub">${sessions.length} session${sessions.length === 1 ? '' : 's'} in the last fortnight</div>
      <div class="board-hint">Pick a session, scrub or replay it. Subagent spans stack above the orchestrator lane.</div>`;
    select.innerHTML = sessions.map((s) => {
      const when = new Date(s.start).toLocaleString();
      return `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(s.project ?? 'unknown')} · ${when} · ${s.agentCount} agent${s.agentCount === 1 ? '' : 's'}</option>`;
    }).join('');
    if (sessions.length === 0) {
      svgEl.replaceChildren();
      detail.innerHTML = '<p class="agents-empty">Nothing to replay yet - flows draw from the same hook event log as the Agents board.</p>';
      current = null;
      flow = null;
      return;
    }
    if (!current || !sessions.some((s) => s.sessionId === current)) {
      current = sessions[0].sessionId;
    }
    select.value = current;
    await load(current);
  }

  // preserve: a live reload of the session already on screen - keep playback
  // running and the scrubber where it is (by absolute timestamp: new events
  // change activeMs, so the fraction must be re-derived against new segments)
  async function load(sessionId, { preserve = false } = {}) {
    const seq = ++loadSeq;
    const sameSession = preserve && sessionId === current && flow !== null;
    if (!sameSession) {
      stopPlay();
      clearTimeout(liveTimer);
    }
    current = sessionId;
    // capture the view against the OLD flow/scale before anything async
    const wasAtEnd = scrubT() >= 0.999;
    const tBefore = sameSession && scale ? scale.fracToTime(scrubT()) : null;
    const res = await fetch(`/api/flows/${encodeURIComponent(sessionId)}`);
    if (seq !== loadSeq || !res.ok) return;
    const json = await res.json();
    if (seq !== loadSeq) return; // a newer load superseded us mid-flight
    flow = json.flow;
    if (!sameSession) {
      scrubEl.value = scrubEl.max; // land showing the whole run
      detail.innerHTML = '';
    }
    draw();
    if (sameSession && !wasAtEnd && tBefore != null && scale) {
      scrubEl.value = Math.round(scale.timeToFrac(tBefore) * Number(scrubEl.max));
      applyScrub();
    }
    // sameSession at the end: scrub stays at max and follows the live edge
  }

  function draw() {
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    scale = null;
    if (!flow || !flow.segments?.length) return;

    // clamp: a container narrower than the margins would invert the range
    const width = Math.max(MARGIN.left + MARGIN.right + 120, svgEl.parentElement.clientWidth || 900);
    const height = MARGIN.top + flow.lanes * LANE_H + MARGIN.bottom;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    scale = makeScale(flow, MARGIN.left, width - MARGIN.right);
    const x = scale.x;
    const laneY = (lane) => MARGIN.top + lane * LANE_H;
    const yTop = MARGIN.top - 8;
    const yBottom = height - MARGIN.bottom + 4;

    // lane guides + labels: orchestrator at 0, one row per packed lane above
    for (let i = 0; i < flow.lanes; i++) {
      svg.append('line').attr('class', 'flow-lane-guide')
        .attr('x1', MARGIN.left).attr('x2', width - MARGIN.right)
        .attr('y1', laneY(i) + LANE_H / 2).attr('y2', laneY(i) + LANE_H / 2);
      svg.append('text').attr('class', 'flow-lane-label')
        .attr('x', MARGIN.left - 10).attr('y', laneY(i) + LANE_H / 2 + 4)
        .attr('text-anchor', 'end')
        .text(i === 0 ? 'orchestrator' : '');
    }

    // idle-gap break markers
    for (const b of flow.breaks) {
      const bx = x(b.at);
      svg.append('rect').attr('class', 'flow-break')
        .attr('x', bx).attr('y', yTop)
        .attr('width', BREAK_PX).attr('height', yBottom - yTop);
      for (const edge of [bx, bx + BREAK_PX]) {
        svg.append('line').attr('class', 'flow-break-edge')
          .attr('x1', edge).attr('x2', edge).attr('y1', yTop).attr('y2', yBottom);
      }
      svg.append('text').attr('class', 'flow-break-label')
        .attr('x', bx + BREAK_PX / 2).attr('y', height - 8)
        .text(`+${fmtDur(b.skippedMs)}`);
    }

    // time axis: round elapsed-time ticks, laid per active segment
    const axisTicks = [];
    for (const seg of flow.segments) {
      const segPx = x(seg.end) - x(seg.start);
      const want = (seg.end - seg.start) / Math.max(1, Math.round(segPx / 90));
      const step = TICK_STEPS.find((s) => s >= want) ?? TICK_STEPS[TICK_STEPS.length - 1];
      let added = false;
      for (let off = Math.ceil((seg.start - flow.start) / step) * step; off <= seg.end - flow.start; off += step) {
        axisTicks.push(flow.start + off);
        added = true;
      }
      if (!added) axisTicks.push(seg.start); // 1-event segments still get a tick
    }
    const breakCenters = flow.breaks.map((b) => x(b.at) + BREAK_PX / 2);
    for (const t of axisTicks) {
      const tx = x(t);
      if (breakCenters.some((c) => Math.abs(tx - c) < 40)) continue; // room for the gap label
      svg.append('text').attr('class', 'flow-axis')
        .attr('x', tx).attr('y', height - 8).attr('text-anchor', 'middle')
        .text(fmtDur(t - flow.start));
    }

    // subagent spans (known start) and start-unknown finish markers
    const realSpans = flow.spans.filter((d) => !d.startUnknown);
    const markers = flow.spans.filter((d) => d.startUnknown);

    const spanSel = svg.selectAll('g.flow-span').data(realSpans).join('g')
      .attr('class', 'flow-span flow-item');
    spanSel.append('rect')
      .attr('x', (d) => x(d.start))
      .attr('y', (d) => laneY(d.lane) + 5)
      .attr('width', (d) => Math.max(MIN_BAR, x(d.end ?? flow.end) - x(d.start)))
      .attr('height', LANE_H - 10)
      .attr('rx', 4)
      .attr('fill', (d) => typeColor(d.type))
      .attr('fill-opacity', 0.75)
      .attr('stroke', (d) => (d.live ? 'var(--accent)' : 'none'))
      .on('click', (ev, d) => showDetail(d));
    // label sits inside the bar only when it fits; otherwise beside it in a
    // light fill - dark-on-dark text overflowing a sliver bar is unreadable
    spanSel.append('text')
      .attr('y', (d) => laneY(d.lane) + LANE_H / 2 + 4)
      .each(function label(d) {
        const estW = d.type.length * 6.5 + 10; // ~11px semibold
        const from = x(d.start);
        const to = from + Math.max(MIN_BAR, x(d.end ?? flow.end) - from);
        const sel = d3.select(this).text(d.type);
        if (to - from >= estW) {
          sel.attr('class', 'flow-span-label').attr('x', from + 5);
        } else if (to + 5 + estW <= width - MARGIN.right) {
          sel.attr('class', 'flow-span-label outside').attr('x', to + 5);
        } else {
          sel.attr('class', 'flow-span-label outside').attr('x', from - 5).attr('text-anchor', 'end');
        }
      });
    spanSel.append('title')
      .text((d) => `${d.type}${d.description ? ` — ${d.description}` : ''}\n${fmtDur(d.start - flow.start)} → ${d.end ? fmtDur(d.end - flow.start) : 'live'}`);

    const markSel = svg.selectAll('g.flow-stop').data(markers).join('g')
      .attr('class', 'flow-stop flow-item');
    markSel.append('path')
      .attr('class', 'flow-stop-unmatched')
      .attr('transform', (d) => `translate(${x(d.start)},${laneY(d.lane) + LANE_H / 2})`)
      .attr('d', 'M0,-7L7,0L0,7L-7,0Z')
      .on('click', (ev, d) => showDetail(d));
    markSel.append('title')
      .text((d) => `subagent finished at ${fmtDur(d.start - flow.start)} (start unknown)`);

    // orchestrator tool ticks + prompt marks on lane 0
    svg.selectAll('line.flow-tick').data(flow.ticks).join('line')
      .attr('class', (d) => `flow-tick flow-item${d.isError ? ' error' : ''}`)
      .attr('x1', (d) => x(d.ts)).attr('x2', (d) => x(d.ts))
      .attr('y1', laneY(0) + 8).attr('y2', laneY(0) + LANE_H - 8)
      .append('title').text((d) => `${d.tool}${d.isError ? ' (error)' : ''} at ${fmtDur(d.ts - flow.start)}`);
    svg.selectAll('path.flow-prompt').data(flow.prompts).join('path')
      .attr('class', 'flow-prompt flow-item')
      .attr('transform', (d) => `translate(${x(d.ts)},${laneY(0) + LANE_H / 2})`)
      .attr('d', 'M0,-7L6,0L0,7L-6,0Z')
      .append('title').text((d) => d.text);

    // scrub line, driven by applyScrub
    svg.append('line').attr('class', 'flow-scrubline').attr('id', 'flow-scrubline')
      .attr('y1', yTop).attr('y2', yBottom);

    applyScrub();
  }

  function applyScrub() {
    if (!flow || !scale) return;
    const t = scale.fracToTime(scrubT());
    d3.select(svgEl).select('#flow-scrubline').attr('x1', scale.x(t)).attr('x2', scale.x(t));
    // future items fade; spans re-clip so a mid-span scrub shows partial progress
    d3.select(svgEl).selectAll('.flow-item')
      .classed('future', (d) => (d.start ?? d.ts) > t);
    d3.select(svgEl).selectAll('g.flow-span rect')
      .attr('width', (d) => {
        const from = scale.x(d.start);
        const to = scale.x(Math.min(d.end ?? flow.end, Math.max(d.start, t)));
        return d.start > t ? Math.max(MIN_BAR, scale.x(d.end ?? flow.end) - from) : Math.max(MIN_BAR, to - from);
      });
  }

  function showDetail(d) {
    const dur = d.startUnknown ? 'finished (start unknown)' : d.end ? fmtDur(d.end - d.start) : 'still running';
    detail.innerHTML = `
      <div class="agent-card">
        <div class="agent-title"><span class="subagent-type">${escapeHtml(d.type)}</span><span class="agent-when">${dur}</span></div>
        ${d.description ? `<div class="agent-activity">${escapeHtml(d.description)}</div>` : ''}
      </div>`;
  }

  // live sessions: refresh the open flow when new hook events arrive
  // (debounced, and view-preserving - it must not fight the user's scrub)
  function onAgents() {
    if (!current) return;
    const active = sessions.find((s) => s.sessionId === current && !s.ended);
    if (!active) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => load(current, { preserve: true }), 1000);
  }

  return { refresh, onAgents };
}
