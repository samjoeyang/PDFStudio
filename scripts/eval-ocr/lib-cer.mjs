// 字符错误率（CER）计算：基于编辑距离（Levenshtein）。
// CER = (S + D + I) / N，其中 N = 参考文本字符数。
// 对中文，空白无意义，默认忽略空格后再算，更公平。

export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export function cer(reference, hypothesis, { ignoreSpaces = true } = {}) {
  const norm = (s) => (ignoreSpaces ? s.replace(/\s+/g, "") : s);
  const r = norm(reference);
  const h = norm(hypothesis);
  const ra = Array.from(r);
  const ha = Array.from(h);
  const edits = editDistance(ra, ha);
  const N = ra.length || 1;
  const c = edits / N;
  return {
    cer: c,
    edits,
    refLen: ra.length,
    hypLen: ha.length,
    charAcc: Math.max(0, 1 - c),
  };
}
