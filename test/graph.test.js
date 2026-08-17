import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVault, parseSkills } from '../lib/vault.js';
import { buildGraph } from '../lib/graph.js';

function buildFixtureGraph(opts = {}) {
  const parsed = parseVault(FIXTURE_VAULT);
  const { skills, warnings } = parseSkills(FIXTURE_VAULT);
  return buildGraph(
    { notes: parsed.notes, skills, warnings: [...parsed.warnings, ...warnings] },
    opts,
  );
}

const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

test('buildGraph on fixture vault: dedupe, ghosts, degree, template rule, routines, apps', () => {
  const graph = buildFixtureGraph({ applicationTags: ['unity', 'nonexistent-tag'] });

  // 5 notes + 1 routine + 1 application (unity) + 1 ghost; unused app tags create nothing
  assert.equal(graph.nodes.length, 8);
  assert.equal(graph.warnings.length, 0); // template name!=stem is exempt

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('ghost-note').type, 'unresolved');
  assert.equal(byId.get('ghost-note').degree, 1);
  assert.equal(byId.has('slug'), false);
  assert.equal(byId.has('project-slug'), false);
  assert.equal(byId.has('SKILL'), false); // unresolvable markdown link: no ghost
  assert.equal(byId.has('capture'), false); // README's link to a skill that doesn't exist
  assert.equal(byId.has('nonexistent-tag'), false);
  assert.equal(byId.get('gamma').degree, 0); // orphan kept
  assert.equal(byId.get('template-note').degree, 0);
  assert.equal(byId.get('testskill').type, 'routine');
  assert.equal(byId.get('testskill').degree, 2); // README (doc link) + alpha (mention)
  assert.equal(byId.get('unity').type, 'application');
  assert.equal(byId.get('unity').degree, 1); // alpha only; template tags ignored
  assert.equal(byId.get('alpha').degree, 4); // beta-lesson, README, testskill, unity
  assert.equal(byId.get('alpha').status, 'active'); // frontmatter carried for the board
  assert.equal(byId.get('alpha').dir, 'C:/Fake/Alpha');

  assert.equal(graph.edges.length, 6);
  const key = (e) => [e.source, e.target].sort().join(' ');
  const edges = new Map(graph.edges.map((e) => [key(e), e]));

  const ab = edges.get('alpha beta-lesson');
  assert.equal(ab.kind, 'frontmatter'); // frontmatter wins over body
  assert.equal(ab.count, 3); // projects: + inline + Related:, deduped to one edge

  assert.equal(edges.get('README alpha').kind, 'body'); // resolved by path
  assert.equal(edges.get('beta-lesson ghost-note').kind, 'body');
  assert.equal(edges.get('README testskill').kind, 'body'); // skill's ../../../README.md link
  assert.equal(edges.get('alpha testskill').kind, 'body'); // mention scan in code span
  assert.equal(edges.get('alpha unity').kind, 'tag');
});

test('buildGraph warns on name/stem mismatch and duplicate ids', () => {
  const note = (over) => ({
    id: 'x', path: 'a/x.md', folder: 'a', type: 'lesson', name: 'x',
    description: null, tags: [], updated: null, status: null, dir: null,
    projectLinks: [], bodyLinks: [], docLinks: [], ...over,
  });
  const g1 = buildGraph({ notes: [note({ name: 'not-x' })] });
  assert.equal(g1.warnings.length, 1);
  assert.match(g1.warnings[0], /name "not-x"/);

  const g2 = buildGraph({ notes: [note(), note({ path: 'b/x.md', folder: 'b' })] });
  assert.ok(g2.warnings.some((w) => w.includes('duplicate note id "x"')));
});

// smoke test against the bundled starter vault - the same tree a fresh clone boots on
const STARTER_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'starter-vault');
test('starter vault smoke test', { skip: !existsSync(STARTER_VAULT) }, () => {
  const parsed = parseVault(STARTER_VAULT);
  const { skills } = parseSkills(STARTER_VAULT);
  const graph = buildGraph(
    { notes: parsed.notes, skills, warnings: parsed.warnings },
    { applicationTags: ['git', 'python', 'obsidian'] },
  );
  assert.ok(graph.nodes.length >= 15, `expected >=15 nodes, got ${graph.nodes.length}`);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.ok(byId.has('orbit-tracker'));
  assert.ok(byId.get('orbit-tracker').degree >= 3, `orbit-tracker degree ${byId.get('orbit-tracker').degree}`);

  // the vault's two skills become connected routine nodes
  assert.equal(byId.get('capture')?.type, 'routine');
  assert.equal(byId.get('triage')?.type, 'routine');
  assert.ok(byId.get('capture').degree >= 1, 'capture should link to at least inbox');

  // tag-derived application nodes
  assert.equal(byId.get('git')?.type, 'application');
  assert.ok(byId.get('git').degree >= 3, `git degree ${byId.get('git').degree}`);

  // template rule: no template node contributes edges
  for (const n of graph.nodes.filter((n) => n.type === 'template')) {
    assert.equal(n.degree, 0, `template ${n.id} should have no edges`);
  }
});
