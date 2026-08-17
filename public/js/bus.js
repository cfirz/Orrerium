// Single shared EventSource: every panel subscribes here by event name so
// five panels never open five /events connections.
let es = null;
const handlers = new Map(); // event -> Set<fn>
const statusHandlers = new Set(); // fn(connected: boolean)

function connect() {
  if (es) return;
  es = new EventSource('/events');
  es.onopen = () => { for (const fn of statusHandlers) fn(true); };
  es.onerror = () => { for (const fn of statusHandlers) fn(false); };
}

export function on(event, fn) {
  connect();
  if (!handlers.has(event)) {
    handlers.set(event, new Set());
    es.addEventListener(event, (ev) => {
      const data = JSON.parse(ev.data);
      for (const h of handlers.get(event)) h(data);
    });
  }
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn);
}

export function onStatus(fn) {
  connect();
  statusHandlers.add(fn);
  return () => statusHandlers.delete(fn);
}
