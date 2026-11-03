// Forgiving search: ignores separators and leading zeros ("fractal maze 7" →
// Fractal Maze 07), splits "maze07", matches word starts and parts, tolerates a
// typo per word, and knows collection names and color words. Best matches first.
(() => {
  'use strict';
  const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? String(+t) : t));

  // a and b differ by at most one insert, delete, change or swap of neighbours.
  function close1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; }
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function tokenScore(q, hay) {
    let best = 0;
    for (const h of hay) {
      if (h === q) return 4;
      if (h.startsWith(q)) best = Math.max(best, 3);
      else if (q.length >= 3 && h.includes(q)) best = Math.max(best, 2);
      else if (q.length >= 4 && (close1(q, h) || close1(q, h.slice(0, q.length)))) best = Math.max(best, 1);
    }
    return best;
  }

  const hayCache = new WeakMap();
  function score(it, qTokens, qJoined) {
    let hay = hayCache.get(it);
    if (!hay) {
      const tokens = [...norm(it.name), ...norm(it.collName || ''), ...(it.colors || [])];
      hay = { tokens, joined: tokens.join('') };
      hayCache.set(it, hay);
    }
    let total = 0;
    for (const q of qTokens) {
      const sc = tokenScore(q, hay.tokens);
      if (!sc) return hay.joined.includes(qJoined) && qJoined.length >= 3 ? 1 : 0;
      total += sc;
    }
    return total + (hay.joined.startsWith(qJoined) ? 2 : 0);
  }

  // Matching items, best first; an empty query returns them all, unchanged.
  function rank(items, query) {
    const qTokens = norm(query);
    if (!qTokens.length) return items.slice();
    const qJoined = qTokens.join('');
    return items.map((it, i) => [it, score(it, qTokens, qJoined), i]).filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([it]) => it);
  }

  globalThis.wpSearch = { rank };
})();
