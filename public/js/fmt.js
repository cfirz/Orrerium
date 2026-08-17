// Shared compound-duration formatter: "45s", "3m 20s", "14m", "21h 30m".
// For elapsed durations only - the relative-time helpers ("5m ago", "in 2h")
// in the panels have different semantics and stay where they are.
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return m >= 10 || rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
