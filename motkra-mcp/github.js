'use strict';

// GitHub REST API client for the MCP server — lets a local agent (Claude/Copilot)
// work with issues, PRs and files without leaving the chat. Plain Node https, no
// dependencies, same style as ollama.js. Auth via GITHUB_TOKEN (env) or the token
// passed in deps; unauthenticated calls hit the low public rate limit (60/hr).

const https = require('https');

const API = 'api.github.com';

/** One GitHub API request. Returns {status, body(parsed)}. Never throws on HTTP errors. */
function ghRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': 'motkra-mcp',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }

    const req = https.request({ hostname: API, path, method, headers }, res => {
      let raw = '';
      res.on('data', c => { if (raw.length < 5_000_000) raw += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('GitHub request timed out (15s)')); });
    if (data) req.write(data);
    req.end();
  });
}

/** Turn a GitHub error body into a short human message. */
function ghError(res, fallback) {
  const b = res.body ?? {};
  const msg = b.message ?? fallback;
  if (res.status === 401) return `GitHub auth failed (401): ${msg}. Set GITHUB_TOKEN.`;
  if (res.status === 403 && /rate limit/i.test(msg)) return `GitHub rate limit hit: ${msg}`;
  if (res.status === 404) return `Not found (404): ${msg}. Check owner/repo and your token's access.`;
  return `GitHub ${res.status}: ${msg}`;
}

/** owner/repo from "owner/repo" or a full github.com URL. */
function parseRepo(repo) {
  const m = String(repo).match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error(`Bad repo "${repo}". Use owner/repo (e.g. williamag929/Quantum_Motrka).`);
  return { owner: m[1], repo: m[2] };
}

/** List issues (or PRs) with optional state/labels filters. Returns a compact text list. */
async function listIssues(repo, { state = 'open', labels, per_page = 20, pull } = {}, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  const q = new URLSearchParams({ state, per_page: String(Math.min(per_page, 100)) });
  if (labels) q.set('labels', labels);
  const res = await request('GET', `/repos/${owner}/${name}/issues?${q}`, null, token);
  if (res.status !== 200) throw new Error(ghError(res, 'list issues failed'));
  const items = (Array.isArray(res.body) ? res.body : [])
    .filter(i => (pull ? !!i.pull_request : !i.pull_request)); // issues endpoint mixes PRs; filter them out
  if (!items.length) return `No ${state} ${pull ? 'pull requests' : 'issues'} in ${owner}/${name}.`;
  return `${owner}/${name} — ${items.length} ${state} ${pull ? 'PR(s)' : 'issue(s)'}:\n` +
    items.map(i => `#${i.number} [${i.state}] ${i.title}  (${i.comments} comments, by @${i.user?.login})`).join('\n');
}

/** One issue with its body and recent comments. */
async function getIssue(repo, number, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  const res = await request('GET', `/repos/${owner}/${name}/issues/${number}`, null, token);
  if (res.status !== 200) throw new Error(ghError(res, `issue #${number}`));
  const i = res.body;
  const commentsRes = await request('GET', `/repos/${owner}/${name}/issues/${number}/comments?per_page=20`, null, token);
  const comments = Array.isArray(commentsRes.body) ? commentsRes.body : [];
  let out = `#${i.number} ${i.title}\nstate: ${i.state} · by @${i.user?.login} · ${i.comments} comments · labels: ${(i.labels ?? []).map(l => l.name).join(', ') || 'none'}\n`;
  out += `url: ${i.html_url}\n\n${i.body ?? '(no body)'}`;
  if (comments.length) {
    out += `\n\n--- comments (${comments.length}) ---\n` +
      comments.map(c => `@${c.user?.login}:\n${c.body}`).join('\n\n---\n');
  }
  return out;
}

/** Create an issue. Returns the new issue's URL. */
async function createIssue(repo, { title, body, labels }, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  if (!title) throw new Error('title is required');
  const res = await request('POST', `/repos/${owner}/${name}/issues`, { title, body, labels }, token);
  if (res.status !== 201) throw new Error(ghError(res, 'create issue failed'));
  return `Created #${res.body.number}: ${res.body.html_url}`;
}

/** Comment on an issue or PR (same endpoint). */
async function comment(repo, number, body, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  if (!body) throw new Error('body is required');
  const res = await request('POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body }, token);
  if (res.status !== 201) throw new Error(ghError(res, 'comment failed'));
  return `Commented on #${number}: ${res.body.html_url}`;
}

/** The unified diff of a PR (what actually changed). */
async function getPRDiff(repo, number, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  const res = await request('GET', `/repos/${owner}/${name}/pulls/${number}`, null, token);
  if (res.status !== 200) throw new Error(ghError(res, `PR #${number}`));
  const p = res.body;
  const head = `${p.head?.repo?.full_name}@${p.head?.ref}`;
  let out = `PR #${p.number}: ${p.title}\nstate: ${p.state}${p.draft ? ' (draft)' : ''} · ${head} → ${p.base?.ref} · +${p.additions}/-${p.deletions} in ${p.changed_files} files\n`;
  out += `url: ${p.html_url}\n\n${p.body ?? '(no description)'}\n\nFetch the diff with: git fetch origin pull/${number}/head && git diff HEAD...FETCH_HEAD`;
  return out;
}

/** List the files a PR changed (name, status, +additions/-deletions, patch when present). */
async function listPRFiles(repo, number, token, request = ghRequest) {
  const { owner, repo: name } = parseRepo(repo);
  const res = await request('GET', `/repos/${owner}/${name}/pulls/${number}/files?per_page=100`, null, token);
  if (res.status !== 200) throw new Error(ghError(res, `PR #${number} files`));
  const files = Array.isArray(res.body) ? res.body : [];
  if (!files.length) return `PR #${number} changed no files.`;
  return `PR #${number} — ${files.length} file(s):\n\n` + files.map(f => {
    let s = `${f.status}  ${f.filename}  (+${f.additions}/-${f.deletions})`;
    if (f.patch) s += `\n${f.patch}`;
    return s;
  }).join('\n\n');
}

module.exports = {
  ghRequest, ghError, parseRepo,
  listIssues, getIssue, createIssue, comment, getPRDiff, listPRFiles,
};

