// Plays lib/demo.js's script in real time into a throwaway tracker. That
// tracker has no data dir, so nothing reaches data/agent-events: the demo can
// never pollute a real history, and stopping it is just dropping the feeder.
// The clock and timers are injected so tests can drive it without waiting.
import { createAgentTracker } from './agents.js';
import { DEMO_SOURCE, LOOP_MS, demoHistory, demoLoop } from './demo.js';

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function createDemoFeeder({
  anchors,
  onChange = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  loopMs = LOOP_MS,
  // the first loop starts this far in the past, so the first tick replays its
  // opening minute at once and a fresh page load already shows live sessions
  primeMs = 60_000,
}) {
  // sessions from two loops back age out on their own
  const tracker = createAgentTracker({ dataDir: null, evictMs: 2 * loopMs, now });
  let loopIndex = 0;
  let loopStart = now() - primeMs;
  let queue = demoLoop({ startTs: loopStart, loopIndex, anchors, loopMs });
  const live = new Map([[loopIndex, []]]); // loop -> sanitized events fed so far
  let history = { day: null, events: [] };
  let timer = null;
  let stopped = false;

  function nextLoop(t) {
    loopIndex += 1;
    // a laptop that slept through several loops restarts from now instead of
    // replaying every missed one
    loopStart = t - loopStart < 2 * loopMs ? loopStart + loopMs : t;
    queue = demoLoop({ startTs: loopStart, loopIndex, anchors, loopMs });
    live.set(loopIndex, []);
    // Flows keeps the current and previous loop, never a half-dropped session
    for (const k of live.keys()) if (k < loopIndex - 1) live.delete(k);
  }

  function tick() {
    timer = null;
    if (stopped) return;
    const t = now();
    if (t >= loopStart + loopMs) nextLoop(t);
    let fed = false;
    while (queue.length && queue[0].ts <= t) {
      live.get(loopIndex).push(...tracker.record(queue.shift(), DEMO_SOURCE));
      fed = true;
    }
    if (fed) onChange(snapshot());
    const due = Math.min(queue[0]?.ts ?? Infinity, loopStart + loopMs);
    timer = setTimer(tick, Math.max(0, due - t));
    timer?.unref?.();
  }

  function snapshot() {
    return { ...tracker.snapshot(), demo: true };
  }

  // Flows and Stats read this instead of the day logs while the demo runs
  function events() {
    const day = dayOf(now());
    if (history.day !== day) history = { day, events: demoHistory({ now: now(), anchors }) };
    return [...history.events, ...[...live.values()].flat()];
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  timer = setTimer(tick, 0);
  timer?.unref?.();
  return { snapshot, events, stop };
}
