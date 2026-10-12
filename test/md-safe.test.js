import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, htmlToken, linkTarget } from '../public/js/md-safe.js';

test('linkTarget keeps http(s), notes, mail and anchors', () => {
  assert.equal(linkTarget('https://example.com/x'), 'external');
  assert.equal(linkTarget('HTTP://EXAMPLE.COM'), 'external');
  assert.equal(linkTarget('lessons/some-lesson.md'), 'note');
  assert.equal(linkTarget('../README.md'), 'note');
  assert.equal(linkTarget('CONVENTIONS.MD'), 'note');
  assert.equal(linkTarget('mailto:me@example.com'), 'anchor');
  assert.equal(linkTarget('#heading'), 'anchor');
});

test('linkTarget drops script vectors in every spelling', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'javascript:alert(1)//x.md', // dressed up as a note link
  ]) {
    assert.equal(linkTarget(href), 'drop', href);
  }
});

test('linkTarget drops relative paths the server does not serve', () => {
  assert.equal(linkTarget('images/diagram.png'), 'drop');
  assert.equal(linkTarget(''), 'drop');
});

test('htmlToken shows raw HTML as text and hides comments', () => {
  assert.equal(htmlToken('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(htmlToken('<script>alert(1)</script>\n'), '&lt;script&gt;alert(1)&lt;/script&gt;\n');
  assert.equal(htmlToken('<!-- a note to self -->\n'), '');
  assert.equal(htmlToken('<!-- multi\nline -->'), '');
  // a comment glued to real markup is not just a comment
  assert.match(htmlToken('<!-- x --><b onclick="y">'), /^&lt;!-- x --&gt;&lt;b/);
});

test('escapeHtml covers the attribute-breaking characters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
});
