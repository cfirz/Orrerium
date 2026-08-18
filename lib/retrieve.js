// Lexical retrieval for vaults too big for one context window. Pure and
// dependency-free: BM25 over the parsed notes, then one hop along each
// selected note's own wikilinks - the link graph is retrieval signal the
// vault already carries. Used by ask() only above ai.maxContextTokens;
// below it the whole vault ships and prompt caching keeps paying.

export const estimateTokens = (text) => Math.ceil(text.length / 4);

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2); // hyphens split, so wikilink ids match their words
}

// body and description once, id/name/tags three times - field weighting by
// repetition instead of BM25F, which would be overkill at this corpus size
export function docBag(doc) {
  const base = tokenize(`${doc.rawBody ?? ''} ${doc.description ?? ''}`);
  const boosted = tokenize(`${doc.id} ${doc.name ?? ''} ${(doc.tags ?? []).join(' ')}`);
  return [...base, ...boosted, ...boosted, ...boosted];
}

// textbook parameters - the corpus is far too small to tune, and no stopword
// list: IDF already zeroes terms that appear everywhere
const K1 = 1.2;
const B = 0.75;

export function bm25Scores(queryTerms, bags) {
  const n = bags.length;
  if (n === 0) return [];
  const avgLen = bags.reduce((sum, bag) => sum + bag.length, 0) / n || 1;
  const df = new Map();
  const tfs = bags.map((bag) => {
    const tf = new Map();
    for (const t of bag) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const terms = [...new Set(queryTerms)];
  return bags.map((bag, i) => {
    let score = 0;
    for (const t of terms) {
      const f = tfs[i].get(t);
      if (!f) continue;
      const d = df.get(t);
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * bag.length) / avgLen));
    }
    return score;
  });
}

// mirrors buildContext's per-note chunk (header + description + body +
// separator) so the budget measures what actually ships
function chunkTokens(doc) {
  const tags = doc.tags?.length ? ` — tags: ${doc.tags.join(', ')}` : '';
  const desc = doc.description ? `\n${doc.description}` : '';
  return estimateTokens(`## [[${doc.id}]] (${doc.type}${tags})${desc}\n\n${(doc.rawBody ?? '').trim()}\n\n---\n\n`);
}

// buildContext's sort order, for the zero-match fallback
const TYPE_ORDER = { root: 0, project: 1, lesson: 2, machine: 3, idea: 4 };

// Picks the notes/skills that fit budgetTokens: BM25 seeds in score order,
// each followed by its unseen 1-hop wikilink neighbours. Docs too big for the
// remaining budget are skipped, not a hard stop - one huge note must not
// starve smaller relevant ones. A question sharing no token with the vault
// falls back to the front of the whole-vault ordering, never to nothing.
export function selectContext({ question, history = [], notes, skills = [], budgetTokens }) {
  const pool = [...notes.filter((n) => n.type !== 'template'), ...skills];
  const byId = new Map(pool.map((d) => [d.id, d]));
  const queryTerms = tokenize(
    [question, ...history.filter((h) => h.role === 'user').map((h) => h.content)].join(' '),
  );
  const scores = bm25Scores(queryTerms, pool.map(docBag));
  const seeds = pool
    .map((doc, i) => ({ doc, score: scores[i] }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = new Set();
  const cap = budgetTokens * 0.95;
  let used = 0;
  const tryAdd = (doc) => {
    if (chosen.has(doc)) return;
    const cost = chunkTokens(doc);
    if (used + cost > cap) return;
    chosen.add(doc);
    used += cost;
  };
  for (const { doc } of seeds) {
    tryAdd(doc);
    if (!chosen.has(doc)) continue;
    for (const link of [...(doc.projectLinks ?? []), ...(doc.bodyLinks ?? [])]) {
      const neighbour = byId.get(link);
      if (neighbour) tryAdd(neighbour);
    }
  }
  if (chosen.size === 0) {
    const ordered = [...pool].sort(
      (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9),
    );
    for (const doc of ordered) tryAdd(doc);
    // a budget smaller than every single note still ships the best one -
    // an over-budget context beats an empty one
    if (chosen.size === 0 && pool.length) chosen.add(seeds[0]?.doc ?? ordered[0]);
  }

  return {
    notes: notes.filter((n) => chosen.has(n)),
    skills: skills.filter((s) => chosen.has(s)),
    filtered: true,
    total: pool.length,
    selected: chosen.size,
  };
}
