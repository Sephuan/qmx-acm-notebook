/* Shared topic hydration and relevance scoring for the algorithm browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NotebookAlgorithmDirectory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function normalize(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/[‐‑‒–—−]/gu, '-').replace(/\s+/gu, ' ').trim();
  }
  function compact(value) { return normalize(value).replace(/[\s_\-()/（）、，,·.:：]/gu, ''); }
  function score(query, fields) {
    const phrase = normalize(query);
    if (!phrase) return 1;
    const terms = phrase.split(/\s+/u).filter(Boolean);
    const prepared = fields.map(field => ({ value: normalize(field.value), dense: compact(field.value), weight: field.weight || 1 }));
    let total = 0;
    for (const term of terms) {
      const dense = compact(term);
      let best = 0;
      for (const field of prepared) {
        if (!field.value) continue;
        const hit = field.value === term || (dense && field.dense === dense) ? 10
          : field.value.startsWith(term) || (dense && field.dense.startsWith(dense)) ? 6
          : field.value.includes(term) || (dense && field.dense.includes(dense)) ? 3 : 0;
        best = Math.max(best, hit * field.weight);
      }
      if (!best) return 0;
      total += best;
    }
    if (terms.length > 1) {
      const dense = compact(phrase);
      total += Math.max(0, ...prepared.map(field => dense && field.dense.includes(dense) ? 5 * field.weight : 0));
    }
    return total;
  }
  function topicScore(node, path, query) {
    return score(query, [{ value: node.label, weight: 12 }, { value: node.fullLabel, weight: 11 },
      ...(node.aliases || []).map(value => ({ value, weight: 10 })), { value: path.join(' / '), weight: 2 }]);
  }
  function noteScore(note, node, path, query, author) {
    return score(query, [{ value: note.title, weight: 12 }, ...(note.tags || []).map(value => ({ value, weight: 9 })),
      { value: node?.label, weight: 8 }, { value: node?.fullLabel, weight: 8 }, ...(node?.aliases || []).map(value => ({ value, weight: 7 })),
      { value: author, weight: 5 }, { value: path.join(' / '), weight: 2 }, { value: note.body, weight: 1 }]);
  }
  const COLORS = ['basic', 'beginner', 'intermediate', 'advanced', 'expert'];
  function splitMixed(tree) {
    function visit(node) {
      node.children = Array.isArray(node.children) ? node.children : [];
      if (node.kind === 'algorithm' && node.children.length) {
        const content = { ...node, id: `algorithm-content-${node.id}`, children: [], kind: 'algorithm', contentOf: node.id };
        for (const key of ['legacyIds', 'sourceHeading', 'part', 'nestedPart', 'metadata']) delete content[key];
        node.children.unshift(content); node.kind = 'directory'; node.color = 'parent'; node.algorithmContentId = content.id;
        node.rating = { status: 'not-applicable', type: 'directory' }; delete node.difficultySource;
      }
      if (node.kind === 'directory' || node.kind === 'category') {
        node.kind = 'directory'; node.color = 'parent';
        node.rating = { status: 'not-applicable', type: 'directory' }; delete node.difficultySource;
      }
      node.children.forEach(visit);
    }
    visit(tree); return tree;
  }
  function hydrate(base, topics = []) {
    const tree = JSON.parse(JSON.stringify(base)), byId = new Map();
    function index(node, depth) {
      node.level = depth; node.children = Array.isArray(node.children) ? node.children : [];
      node.fullLabel = node.fullLabel || node.label;
      byId.set(node.id, node); for (const id of node.legacyIds || []) byId.set(id, node);
      node.children.forEach(child => index(child, depth + 1));
    }
    splitMixed(tree); index(tree, 0);
    let pending = Array.isArray(topics) ? topics.slice() : [];
    for (let round = 0; pending.length && round <= topics.length; round++) {
      const next = []; let added = 0;
      for (const record of pending) {
        if (!record || typeof record.id !== 'string' || byId.has(record.id)) continue;
        const parent = byId.get(record.parentId);
        if (!parent) { next.push(record); continue; }
        if (!(record.kind === 'directory' ? record.color === 'parent' : COLORS.includes(record.color)) || typeof record.label !== 'string') continue;
        const node = { id: record.id, label: record.label, fullLabel: record.fullLabel || record.label, color: record.color,
          scope: record.scope || '', rationale: '由管理员按学习范围添加。', children: [], attributes: [],
          aliases: record.fullLabel && record.fullLabel !== record.label ? [record.fullLabel] : [],
          kind: record.kind === 'directory' ? 'directory' : 'algorithm', origin: 'admin', difficultySource: { kind: 'admin' }, level: parent.level + 1 };
        parent.children.push(node); splitMixed(tree); index(tree, 0); added++;
      }
      if (!added) break; pending = next;
    }
    function ranges(node) {
      const values = [COLORS.indexOf(node.color) + 1, ...node.children.flatMap(child => { const r = ranges(child); return r ? [r.min, r.max] : []; })].filter(n => n > 0);
      const range = values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
      if (node.kind === 'directory') node.rating = { status: 'not-applicable', type: 'directory' };
      else node.rating = { ...(node.rating || {}), ...(range ? { range } : {}) }; return range;
    }
    ranges(tree); return tree;
  }
  return Object.freeze({ normalize, compact, score, topicScore, noteScore, splitMixed, hydrate });
});
