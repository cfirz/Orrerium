import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanClaudeAssets, mergeClaudeAssets } from '../lib/claude-scan.js';

const TREE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-tree');

function scanFixture() {
  return scanClaudeAssets({
    roots: [TREE],
    globalDir: path.join(TREE, 'globalhome'),
    settingsPath: path.join(TREE, 'globalhome', 'settings.json'),
  });
}

test('scanClaudeAssets: skills, agents, commands, namespacing, overrides', () => {
  const { items, warnings } = scanFixture();
  assert.equal(warnings.length, 0);

  const byId = new Map(items.map((i) => [i.id, i]));
  // globalhome is also a child dir of the fixture root, but as a repo it has no
  // .claude/ subdir, so only the explicit globalDir scan picks it up
  assert.deepEqual(
    items.map((i) => i.id).sort(),
    ['Repo-B.spacey', 'RepoA.deploy', 'RepoA.helper', 'RepoA.qa-agent', 'global.dormant', 'global.helper2'],
  );

  const qa = byId.get('RepoA.qa-agent');
  assert.equal(qa.kind, 'agent');
  assert.equal(qa.type, 'agent');
  assert.equal(qa.label, 'qa-agent');
  assert.equal(qa.scope, 'repo');
  assert.equal(qa.repo, 'RepoA');
  assert.match(qa.description, /quality gate after implementation — linters, type checks, and the full test suite\./);
  assert.ok(path.isAbsolute(qa.path));

  assert.equal(byId.get('RepoA.deploy').type, 'command');
  assert.equal(byId.get('RepoA.helper').type, 'routine');
  assert.equal(byId.get('Repo-B.spacey').label, 'spacey'); // space sanitized out of the prefix

  const dormant = byId.get('global.dormant');
  assert.equal(dormant.scope, 'global');
  assert.equal(dormant.disabled, true); // skillOverrides: "off"
  assert.equal(byId.get('global.helper2').disabled, true); // override keyed on dir name, not frontmatter name
  assert.equal(byId.get('RepoA.helper').disabled, false);
});

test('scanClaudeAssets: skipDirs drops a repo, missing roots warn', () => {
  const { items } = scanClaudeAssets({ roots: [TREE], skipDirs: [path.join(TREE, 'RepoA')] });
  assert.ok(!items.some((i) => i.repo === 'RepoA'));
  const { warnings } = scanClaudeAssets({ roots: [path.join(TREE, 'no-such-root')] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot read root/);
});

test('mergeClaudeAssets: project-dir join, repo anchors, degree upkeep', () => {
  const { items } = scanFixture();
  const graph = {
    nodes: [
      // a vault project note pointing at RepoA - its items must attach here
      { id: 'repo-a-project', type: 'project', dir: path.join(TREE, 'RepoA').replaceAll('\\', '/'), degree: 0 },
    ],
    edges: [],
    warnings: [],
  };
  mergeClaudeAssets(graph, items);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // RepoA items attach to the project node, no synthetic RepoA node appears
  assert.equal(byId.has('RepoA'), false);
  assert.equal(byId.get('repo-a-project').degree, 3); // qa-agent + deploy + helper
  // Repo B has no project note - synthetic repo anchor
  const repoB = byId.get('Repo-B');
  assert.equal(repoB.type, 'repo');
  assert.equal(repoB.label, 'Repo B');
  assert.equal(repoB.degree, 1);
  assert.equal(byId.get('Repo-B.spacey').degree, 1);
  // globals stay unanchored
  assert.equal(byId.get('global.dormant').degree, 0);

  const kinds = new Set(graph.edges.map((e) => e.kind));
  assert.deepEqual([...kinds], ['scan']);
  assert.equal(graph.warnings.length, 0);
});

test('mergeClaudeAssets: duplicate item id is skipped with a warning', () => {
  const { items } = scanFixture();
  const clash = items.find((i) => i.id === 'RepoA.helper');
  const graph = { nodes: [{ id: 'RepoA.helper', type: 'routine', dir: null, degree: 0 }], edges: [], warnings: [] };
  mergeClaudeAssets(graph, [clash]);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.warnings.length, 1);
  assert.match(graph.warnings[0], /duplicate id/);
});
