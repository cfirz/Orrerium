// Checked on every request before routing. Orrerium has no auth: it trusts
// "only this machine can reach the port", and two browser tricks get around
// that without touching any network config:
//  - cross-site requests: any page you visit can POST to 127.0.0.1. A
//    text/plain body is a CORS "simple request", so no preflight stops it.
//  - DNS rebinding: a hostile domain re-points itself at 127.0.0.1 and then
//    reads responses as same-origin - but its Host header still names it.
// Host pinning stops the second, Origin/Sec-Fetch-Site the first. Non-browser
// clients (hooks/emit.js's Node fetch, curl) send neither of those headers,
// so hook ingest is untouched. Pure: header in, verdict out.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopback(host) {
  return LOOPBACK.has(String(host).toLowerCase());
}

// the Host values a browser sends for a loopback listener; port 80 is the one
// a browser leaves off
export function loopbackHosts(port) {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const hosts = new Set(names.map((n) => `${n}:${port}`));
  if (Number(port) === 80) for (const n of names) hosts.add(n);
  return hosts;
}

// -> null to proceed, or { status, error } to refuse
export function checkRequest({ method, headers = {} }, { host, port }) {
  const hostHeader = String(headers.host ?? '').toLowerCase();
  // bound elsewhere, the user chose to expose it (SECURITY.md) and any name
  // may legitimately reach it - only a loopback listener can pin its Host
  if (isLoopback(host) && !loopbackHosts(port).has(hostHeader)) {
    return { status: 403, error: 'unexpected Host header' };
  }
  if (method === 'GET' || method === 'HEAD') return null; // no side effects, and cross-site reads stay CORS-blocked

  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://${hostHeader}`) {
    return { status: 403, error: 'cross-origin request refused' };
  }
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: 'cross-site request refused' };
  }
  return null;
}
