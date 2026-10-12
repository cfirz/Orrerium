// Shared markdown renderer: marked configured once with the wikilink
// tokenizer and the in-app link routing, used by the note panel and inbox.
import { marked } from '/vendor/marked.esm.js';
import { escapeHtml, htmlToken, linkTarget } from './md-safe.js';

export { escapeHtml }; // the panels' long-standing import site

// wikilinks handled at the tokenizer level - no regex-vs-code-fence worries
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) {
      const i = src.indexOf('[[');
      return i === -1 ? undefined : i;
    },
    // [[slug]], [[slug|shown text]], [[slug#heading]] - the same forms
    // lib/vault.js turns into graph edges; the target is the part before # or |
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
      if (!m) return undefined;
      const slug = m[1].trim();
      return { type: 'wikilink', raw: m[0], slug, label: m[2]?.trim() || slug };
    },
    renderer(token) {
      return `<a class="wikilink" data-slug="${escapeHtml(token.slug)}">${escapeHtml(token.label)}</a>`;
    },
  }],
  renderer: {
    // raw HTML renders as text - the rules and the why live in md-safe.js
    html(token) {
      return htmlToken(token.text);
    },
    // route relative .md links (the root docs' style) through the same
    // data-slug navigation; external links open in a new tab
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = token.href ?? '';
      switch (linkTarget(href)) {
        case 'external':
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
        case 'note':
          return `<a class="wikilink" data-slug="${escapeHtml(href.split('/').pop().slice(0, -3))}">${text}</a>`;
        case 'anchor':
          return `<a href="${escapeHtml(href)}">${text}</a>`;
        default:
          return text; // keep the words, drop the link
      }
    },
  },
});

export function renderMarkdown(text) {
  return marked.parse(text);
}
