// Shared markdown renderer: marked configured once with the wikilink
// tokenizer and the in-app link routing, used by the note panel and ask panel.
import { marked } from '/vendor/marked.esm.js';

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// wikilinks handled at the tokenizer level - no regex-vs-code-fence worries
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) {
      const i = src.indexOf('[[');
      return i === -1 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)\]\]/.exec(src);
      if (m) return { type: 'wikilink', raw: m[0], slug: m[1].trim() };
    },
    renderer(token) {
      const slug = escapeHtml(token.slug);
      return `<a class="wikilink" data-slug="${slug}">${slug}</a>`;
    },
  }],
  renderer: {
    // route relative .md links (the root docs' style) through the same
    // data-slug navigation; external links open in a new tab
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = token.href ?? '';
      if (/^https?:\/\//.test(href)) {
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
      }
      if (href.endsWith('.md')) {
        const slug = escapeHtml(href.split('/').pop().slice(0, -3));
        return `<a class="wikilink" data-slug="${slug}">${text}</a>`;
      }
      return `<a href="${escapeHtml(href)}">${text}</a>`;
    },
  },
});

export function renderMarkdown(text) {
  return marked.parse(text);
}
