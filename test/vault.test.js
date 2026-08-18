import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseVault, parseSkills, parseFrontmatter, stripCode,
  extractWikilinks, extractMarkdownLinks, normalizeLinkPath,
} from '../lib/vault.js';

const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

test('frontmatter: quoted string keeps # and commas', () => {
  const { fields } = parseFrontmatter('---\ndescription: "has # hash, and comma"\n---\nbody');
  assert.equal(fields.description, 'has # hash, and comma');
});

test('frontmatter: escaped quote inside quoted string', () => {
  const { fields } = parseFrontmatter('---\ndescription: "say \\"hi\\" now"\n---\n');
  assert.equal(fields.description, 'say "hi" now');
});

test('frontmatter: inline comment stripped from plain value', () => {
  const { fields } = parseFrontmatter('---\ntype: template          # set to: project\n---\n');
  assert.equal(fields.type, 'template');
});

test('frontmatter: flow lists - bare, quoted wikilinks, empty', () => {
  const { fields } = parseFrontmatter(
    '---\ntags: [unity, gotcha]\nprojects: ["[[a]]", "[[b]]"]\nempty: []\n---\n'
  );
  assert.deepEqual(fields.tags, ['unity', 'gotcha']);
  assert.deepEqual(fields.projects, ['[[a]]', '[[b]]']);
  assert.deepEqual(fields.empty, []);
});

test('frontmatter: absent or unclosed block leaves body intact', () => {
  const noFm = parseFrontmatter('just a body\nwith lines');
  assert.deepEqual(noFm.fields, {});
  assert.equal(noFm.markdown, 'just a body\nwith lines');

  const unclosed = parseFrontmatter('---\nname: x\nnever closed');
  assert.deepEqual(unclosed.fields, {});
  assert.match(unclosed.markdown, /never closed/);
});

test('frontmatter: CRLF tolerated', () => {
  const { fields, markdown } = parseFrontmatter('---\r\nname: x\r\n---\r\nbody');
  assert.equal(fields.name, 'x');
  assert.equal(markdown, 'body');
});

test('stripCode removes fenced blocks and inline code', () => {
  const out = stripCode('a [[real]] b\n```dataview\n[[fenced]]\n```\nc `[[inline]]` d');
  assert.deepEqual(extractWikilinks(out), ['real']);
});

test('extractMarkdownLinks: relative .md paths kept, external ignored', () => {
  const links = extractMarkdownLinks('[a](projects/orbit-tracker.md) [b](https://x.com/y.md) [c](#anchor)');
  assert.deepEqual(links, ['projects/orbit-tracker.md']);
});

test('normalizeLinkPath strips relative prefixes and backslashes', () => {
  assert.equal(normalizeLinkPath('../../../CONVENTIONS.md'), 'CONVENTIONS.md');
  assert.equal(normalizeLinkPath('.\\projects\\orbit-tracker.md'), 'projects/orbit-tracker.md');
});

test('frontmatter: indented continuation lines join a plain value', () => {
  const { fields } = parseFrontmatter('---\nname: x\ndescription: first part\n  second part\n---\n');
  assert.equal(fields.description, 'first part second part');
});

test('parseSkills on fixture vault', () => {
  const { skills, warnings } = parseSkills(FIXTURE_VAULT);
  assert.equal(warnings.length, 0);
  assert.equal(skills.length, 1);
  const s = skills[0];
  assert.equal(s.id, 'testskill');
  assert.equal(s.type, 'routine');
  assert.equal(s.description, 'A test routine that spans two lines');
  assert.deepEqual(s.docLinks, ['README.md']); // ../../../ normalized away
  assert.match(s.rawBody, /alpha\.md/); // mention scanning happens in buildGraph
});

test('parseVault on fixture vault', () => {
  const { notes, warnings } = parseVault(FIXTURE_VAULT);
  assert.equal(warnings.length, 0);
  assert.equal(notes.length, 5);

  const byId = new Map(notes.map((n) => [n.id, n]));
  const beta = byId.get('beta-lesson');
  assert.equal(beta.folder, 'lessons');
  assert.equal(beta.type, 'lesson');
  assert.deepEqual(beta.projectLinks, ['alpha']);
  assert.deepEqual(beta.bodyLinks, ['alpha', 'ghost-note', 'alpha']);

  const alpha = byId.get('alpha');
  assert.deepEqual(alpha.bodyLinks, []); // fenced + inline-code links must not count
  assert.equal(alpha.dir, 'C:/Fake/Alpha');

  const readme = byId.get('README');
  assert.equal(readme.folder, null);
  assert.equal(readme.type, 'root');
  assert.deepEqual(readme.bodyLinks, []); // wikilinks only
  assert.deepEqual(readme.docLinks, ['projects/alpha.md', '.claude/skills/capture/SKILL.md']); // resolution happens in buildGraph

  const template = byId.get('template-note');
  assert.equal(template.type, 'template'); // inline comment stripped
  assert.equal(template.name, 'template-slug');
});

// a throwaway vault whose notes carry no frontmatter `type:`, so the type can
// only come from the folder map (the shared fixture sets types explicitly)
function makeVault(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orrerium-vault-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('folder-derived types follow the default map', () => {
  const dir = makeVault({
    'projects/rover.md': '# Rover\n',
    'elsewhere/stray.md': '# Stray\n',
  });
  const byId = new Map(parseVault(dir).notes.map((n) => [n.id, n]));
  assert.equal(byId.get('rover').type, 'project');
  assert.equal(byId.get('stray').type, 'root'); // unknown folder falls through
});

test('a custom folderTypes map replaces the default and frontmatter still wins', () => {
  const dir = makeVault({
    'docs/guide.md': '# Guide\n',
    'projects/rover.md': '# Rover\n',
    'docs/special.md': '---\ntype: machine\n---\n# Special\n',
  });
  const byId = new Map(
    parseVault(dir, { folderTypes: { docs: 'idea' } }).notes.map((n) => [n.id, n]),
  );
  assert.equal(byId.get('guide').type, 'idea'); // custom mapping
  assert.equal(byId.get('rover').type, 'root'); // replacement: projects/ no longer mapped
  assert.equal(byId.get('special').type, 'machine'); // frontmatter beats the map
});
