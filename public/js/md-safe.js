// The markdown renderer's safety decisions, kept import-free so node --test can
// load them (md.js imports marked from /vendor by absolute path, which only
// resolves in the browser). marked has no sanitizer, and not every note is the
// user's own: the graph also shows .claude/*.md files scanned from other
// people's repos - so raw HTML becomes text and only known-safe links survive.

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// a raw HTML token -> what goes in the page: comments vanish, as they would in
// Obsidian; everything else shows as the literal text it is
export function htmlToken(text) {
  return /^\s*<!--[\s\S]*-->\s*$/.test(text) ? '' : escapeHtml(text);
}

// a link href -> how to render it:
//   'external' http(s), opens in a new tab
//   'note'     a relative .md path, routed through the graph's navigation
//   'anchor'   mailto: or an in-page #fragment, kept as a plain link
//   'drop'     anything else - script vectors (javascript:, data:, vbscript:)
//              and relative paths this server does not serve - text only
export function linkTarget(href) {
  if (/^https?:\/\//i.test(href)) return 'external';
  if (/^(mailto:|#)/i.test(href)) return 'anchor';
  // a scheme-less relative path; a colon before any slash would be a scheme
  if (href.toLowerCase().endsWith('.md') && !/^[^/]*:/.test(href)) return 'note';
  return 'drop';
}
