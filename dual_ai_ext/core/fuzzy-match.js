'use strict';

// Self-correction hints for a failed str_replace (20B-1).
//
// When the model's old_string doesn't match the file, a bare "Text not found"
// gives it nothing to work with and it usually retries the same bad string.
// Production agents (Hermes, Aider, Cline) instead hand the model a *reason*
// plus the closest real section so it can self-correct without a read_file
// round-trip. These helpers build that feedback as a plain string for the model.
//
// Everything here is pure (no fs, no vscode) so it is unit-testable on its own.

/** Collapse runs of whitespace so "mostly the same text, different spacing" matches. */
function normalizeWhitespace(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/** True when old and new differ only by whitespace/line endings. */
function differsOnlyByWhitespace(oldText, content) {
  return !content.includes(oldText) &&
    normalizeWhitespace(content).includes(normalizeWhitespace(oldText));
}

function tokens(s) {
  return String(s).toLowerCase().match(/\w+/g) ?? [];
}

function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Similarity in [0,1] between two strings, in the spirit of difflib's
 * SequenceMatcher.ratio(): 2*M/(lenA+lenB) where M is a longest-common-
 * subsequence length. Falls back to a token overlap for very large inputs.
 */
function similarity(a, b) {
  if (a === b) return 1;
  const A = String(a), B = String(b);
  if (!A.length || !B.length) return 0;
  const m = A.length, n = B.length;
  const CAP = 4000;
  if (m > CAP || n > CAP) return jaccard(A, B);
  let prev = new Uint32Array(n + 1);
  let cur = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = A[i - 1] === B[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return (2 * prev[n]) / (m + n);
}

/**
 * Find the windows of `content` (by lines) most similar to `oldText`.
 * A window is a run of lines matching oldText's line count, so the model gets
 * a realistic, line-aligned candidate.
 *
 * @returns {Array<{startLine:number,endLine:number,firstShownLine:number,score:number,text:string}>}
 */
function findClosestLines(content, oldText, { topN = 3, threshold = 0.3, context = 1 } = {}) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const span = Math.max(normalizeWhitespace(oldText).split('\n').length, 1);
  const needle = normalizeWhitespace(oldText);

  const scored = [];
  for (let i = 0; i + span <= lines.length; i++) {
    const window = lines.slice(i, i + span).join('\n');
    const score = similarity(needle, normalizeWhitespace(window));
    if (score >= threshold) scored.push({ startLine: i, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const cand of scored) {
    if (chosen.some(c => Math.abs(c.startLine - cand.startLine) < span)) continue;
    const from = Math.max(0, cand.startLine - context);
    const to = Math.min(lines.length - 1, cand.startLine + span - 1 + context);
    chosen.push({
      startLine: cand.startLine,
      endLine: to,
      firstShownLine: from,
      score: cand.score,
      text: lines.slice(from, to + 1).join('\n'),
    });
    if (chosen.length >= topN) break;
  }
  return chosen;
}

/**
 * Build the feedback string a str_replace failure returns to the model.
 * Always actionable: says it failed, why (whitespace vs. genuinely absent),
 * shows the closest real section with line numbers, and tells it to re-read
 * and retry — or fall back to write_file for a full rewrite.
 *
 * @param {string} oldText  the model's old_string
 * @param {string} content  current file contents
 * @param {string} [filePath]
 * @returns {string}
 */
function formatNoMatchHint(oldText, content, filePath = '') {
  const where = filePath ? ` in ${filePath}` : '';
  const head = `str_replace failed: old_string was not found${where}. Nothing was changed.`;

  if (differsOnlyByWhitespace(oldText, content)) {
    return [
      head,
      'The text is there but the whitespace/line-endings differ from what you sent.',
      'Re-read the file and copy the exact characters (spaces, tabs, indentation, CRLF vs LF) into old_string, then retry.',
    ].join('\n');
  }

  const near = findClosestLines(content, oldText, { topN: 2, threshold: 0.3, context: 1 });
  if (near.length) {
    const blocks = near.map(m =>
      `  around line ${m.firstShownLine + 1} (${(m.score * 100).toFixed(0)}% match):\n` +
      m.text.split('\n').map((l, k) => `    ${m.firstShownLine + k + 1}| ${l}`).join('\n')
    ).join('\n\n');
    return [
      head,
      'Closest matching section(s) in the file — use one of these as old_string:',
      blocks,
      '',
      'Re-read the file to confirm, then retry str_replace with the exact text above. If the change spans most of the file, use write_file instead.',
    ].join('\n');
  }

  return [
    head,
    'No similar text was found, so old_string does not correspond to this file.',
    'Call read_file on this path first to see its current contents, then retry str_replace against what is actually there.',
  ].join('\n');
}

module.exports = {
  normalizeWhitespace,
  differsOnlyByWhitespace,
  similarity,
  findClosestLines,
  formatNoMatchHint,
};

