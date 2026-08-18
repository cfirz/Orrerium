import test from 'node:test';
import assert from 'node:assert/strict';
import { bm25Scores, docBag, estimateTokens, selectContext, tokenize } from '../lib/retrieve.js';

const note = (id, over = {}) => ({
  id, path: `${id}.md`, folder: 'projects', type: 'project', name: id,
  description: null, tags: [], updated: null, status: null, dir: null,
  projectLinks: [], bodyLinks: [], docLinks: [], rawBody: '', ...over,
});

test('tokenize lowercases, splits on non-alphanumerics, drops single chars', () => {
  assert.deepEqual(tokenize('Orbit-Tracker v2: a GAME!'), ['orbit', 'tracker', 'v2', 'game']);
  assert.deepEqual(tokenize(null), []);
});

test('estimateTokens is chars/4 rounded up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
});

test('bm25 ranks a matching doc above a non-match, and rarer terms higher', () => {
  const bags = [
    tokenize('rockets and rocket engines burn fuel'),
    tokenize('gardens grow herbs and fuel compost'),
    tokenize('fuel fuel fuel logistics'),
  ];
  const rocket = bm25Scores(tokenize('rocket'), bags);
  assert.ok(rocket[0] > 0);
  assert.equal(rocket[1], 0);
  // 'rocket' appears in one doc, 'fuel' in all three - the rare term must
  // dominate a query carrying both
  const mixed = bm25Scores(tokenize('rocket fuel'), bags);
  assert.ok(mixed[0] > mixed[2]);
});

test('docBag weights id/name/tags by repetition', () => {
  const bag = docBag(note('orbit-tracker', { name: 'flighttool', tags: ['unity'], rawBody: 'a game' }));
  assert.equal(bag.filter((t) => t === 'orbit').length, 3);
  assert.equal(bag.filter((t) => t === 'unity').length, 3);
  assert.equal(bag.filter((t) => t === 'game').length, 1);
});

test('selectContext keeps the scored note and pulls its zero-score neighbour', () => {
  const notes = [
    note('engine', { rawBody: 'rocket engine design notes', bodyLinks: ['appendix'] }),
    note('appendix', { rawBody: 'tables of numbers' }),
    note('garden', { rawBody: 'compost heap layout' }),
  ];
  const sel = selectContext({ question: 'rocket engines', notes, budgetTokens: 200 });
  const ids = sel.notes.map((n) => n.id);
  assert.ok(ids.includes('engine'));
  assert.ok(ids.includes('appendix')); // 1-hop expansion, no query overlap needed
  assert.ok(!ids.includes('garden'));
  assert.equal(sel.filtered, true);
  assert.equal(sel.total, 3);
});

test('selectContext respects the budget and skips oversized docs without stopping', () => {
  const notes = [
    note('huge', { rawBody: `rocket ${'x'.repeat(4000)}` }),
    note('small', { rawBody: 'rocket fits fine' }),
  ];
  const sel = selectContext({ question: 'rocket', notes, budgetTokens: 100 });
  const ids = sel.notes.map((n) => n.id);
  assert.deepEqual(ids, ['small']); // huge skipped, scan continued
});

test('a question sharing no token with the vault falls back to type order', () => {
  const notes = [
    note('idea-note', { type: 'idea', rawBody: 'loose thought' }),
    note('proj-note', { rawBody: 'project body' }),
  ];
  const sel = selectContext({ question: 'zzzzqqqq', notes, budgetTokens: 500 });
  assert.ok(sel.notes.length > 0); // never an empty context
  assert.deepEqual(sel.notes.map((n) => n.id), ['idea-note', 'proj-note']); // original array order
});

test('prior user turns steer the selection', () => {
  const notes = [
    note('engine', { rawBody: 'rocket engine design' }),
    note('garden', { rawBody: 'compost heap layout' }),
  ];
  const history = [{ role: 'user', content: 'tell me about compost' }, { role: 'assistant', content: 'ok' }];
  const sel = selectContext({ question: 'and what else?', history, notes, budgetTokens: 500 });
  assert.ok(sel.notes.map((n) => n.id).includes('garden'));
});

test('templates and non-linked skills stay out; matching skills come along', () => {
  const notes = [note('tpl', { type: 'template', rawBody: 'rocket boilerplate' })];
  const skills = [note('launch-routine', { type: 'routine', rawBody: 'rocket launch steps' })];
  const sel = selectContext({ question: 'rocket', notes, skills, budgetTokens: 500 });
  assert.deepEqual(sel.notes, []);
  assert.deepEqual(sel.skills.map((s) => s.id), ['launch-routine']);
});
