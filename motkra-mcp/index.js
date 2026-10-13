#!/usr/bin/env node
'use strict';

/**
 * Motkra MCP Server — exposes local Ollama models to Claude Desktop and any
 * MCP-compatible client.
 *
 * Transport:
 *   stdio   — always active; connect from Claude Desktop via mcpServers config
 *   TCP     — active when MOTKRA_MCP_PORT env var is set (same JSON-RPC protocol)
 *
 * Claude Desktop config example (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "motkra": {
 *         "command": "node",
 *         "args": ["/path/to/motkra-mcp/index.js"]
 *       }
 *     }
 *   }
 *
 * Claude Code: registered in ../.mcp.json, so a session in this repo can hand work to
 * the local model and keep it out of its own context.
 *
 * Tools exposed:
 *   motkra_digest       — the local model reads files from disk and returns a short,
 *                         redacted answer; runs in the background past wait_seconds
 *   motkra_result       — collect a background digest
 *   ollama_chat         — send messages to any local Ollama model
 *   ollama_list_models  — list all models available on this machine
 *   github_list_issues  — list issues or PRs in a repo (needs GITHUB_TOKEN for private repos)
 *   github_get_issue    — read one issue/PR with its body and comments
 *   github_create_issue — create an issue
 *   github_comment      — comment on an issue/PR
 *   github_pr_diff      — a PR's title/state/branches/+additions and how to fetch its diff
 *   github_pr_files     — the files a PR changed, with each diff patch
 */

const readline = require('readline');
const net      = require('net');

const { digest, readInputs, pythonRedact } = require('./digest');
const { JobQueue } = require('./jobs');
const { DiskJobs } = require('./disk-jobs');
const { DIGEST_MODEL, ollamaChat, digestChat, ollamaListModels } = require('./ollama');
const gh = require('./github');
const { runTask } = require('./task');

const DEFAULT_WAIT = 45;
// Some clients give up on a tool call after 60 s (Claude's remote bridge did), and a call
// that times out loses its reply. Return a job_id before that and let motkra_result poll.
const MAX_WAIT     = 50;

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name:        'motkra_digest',
    description:
      'Hand reading work to Motkra, the local model on this machine. It reads the files itself and returns ' +
      'a short answer citing path:line, so the file contents never enter your context. Use it for large ' +
      'inputs where you only need a conclusion: test or build logs (write command output to a file first), ' +
      'long files, "where/does X happen" questions. Answers come from a small local model: treat them as ' +
      'leads and check anything you will act on. Secrets in the answer are redacted. The local model is ' +
      'slow (about 1-2 minutes per 20k characters); if it is not done within wait_seconds you get a job_id ' +
      'and should keep working, then call motkra_result.',
    inputSchema: {
      type: 'object',
      properties: {
        paths:        { type: 'array', items: { type: 'string' }, description: 'Files to read, relative to the workspace root (max 50)' },
        question:     { type: 'string', description: 'What you want to know from the files' },
        pattern:      { type: 'string', description: 'Optional case-insensitive regex: only matching lines (plus 2 lines of context) are read. Use it to cut logs down, e.g. "error|fail|traceback"' },
        max_words:    { type: 'integer', description: 'Answer length limit (default 150)' },
        wait_seconds: { type: 'integer', description: `How long to wait before returning a job_id (default ${DEFAULT_WAIT}, max ${MAX_WAIT}; 0 = return a job_id at once)` },
      },
      required: ['paths', 'question'],
    },
  },
  {
    name:        'motkra_result',
    description: 'Collect the result of a background motkra_digest job, waiting up to wait_seconds for it to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id:       { type: 'string' },
        wait_seconds: { type: 'integer', description: `Default ${DEFAULT_WAIT}, max ${MAX_WAIT}` },
      },
      required: ['job_id'],
    },
  },
  {
    name:        'ollama_chat',
    description: 'Send a chat message to a local Ollama model. Use this to run inference on a locally hosted LLM without sending data to the cloud.',
    inputSchema: {
      type: 'object',
      properties: {
        model:  { type: 'string', description: 'Ollama model name, e.g. gemma4:e2b or llama3.2' },
        prompt: { type: 'string', description: 'User message to send' },
        system: { type: 'string', description: 'Optional system prompt' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name:        'ollama_list_models',
    description: 'List all Ollama models currently available on this machine.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'github_list_issues',
    description: 'List issues (or pull requests) in a GitHub repo. Set pull=true to list PRs instead. Requires GITHUB_TOKEN for private repos and a higher rate limit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:     { type: 'string', description: 'owner/repo, e.g. williamag929/Quantum_Motrka' },
        state:    { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' },
        labels:   { type: 'string', description: 'Comma-separated label filter' },
        per_page: { type: 'integer', description: 'Max results (default 20, max 100)' },
        pull:     { type: 'boolean', description: 'true = list pull requests instead of issues' },
      },
      required: ['repo'],
    },
  },
  {
    name:        'github_get_issue',
    description: 'Read one GitHub issue or PR with its body and recent comments — full context for working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'owner/repo' },
        number: { type: 'integer', description: 'Issue or PR number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name:        'github_create_issue',
    description: 'Create a new issue in a GitHub repo. Needs a token with repo scope.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'owner/repo' },
        title:  { type: 'string', description: 'Issue title' },
        body:   { type: 'string', description: 'Issue body (markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name:        'github_comment',
    description: 'Post a comment on a GitHub issue or PR. Needs a token with repo scope.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'owner/repo' },
        number: { type: 'integer', description: 'Issue or PR number' },
        body:   { type: 'string', description: 'Comment text (markdown)' },
      },
      required: ['repo', 'number', 'body'],
    },
  },
  {
    name:        'github_pr_diff',
    description: 'Get a pull request: title, state, branch mapping, +additions/-deletions, and how to fetch its diff locally.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'owner/repo' },
        number: { type: 'integer', description: 'PR number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name:        'github_pr_files',
    description: 'List the files a pull request changed, with each file\'s diff patch — review a PR without leaving the chat.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'owner/repo' },
        number: { type: 'integer', description: 'PR number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name:        'motkra_task',
    description:
      'Delegate a complete, multi-step coding task to Motkra, an autonomous agent on this machine. It reads and ' +
      'edits files, runs commands and tests, and self-corrects until the goal is met, then reports what it ' +
      'changed. Use it for hands-off work you would otherwise do step by step ("add input validation to the ' +
      'signup form and run the tests", "refactor module X and fix what breaks"). It runs the full agent loop ' +
      'with its own tools; every action is logged so you stay the supervisor. Needs the Anthropic API key in ' +
      'the server\'s environment. Writes are auto-applied (set MOTKRA_TASK_REQUIRE_APPROVAL=1 for a dry-run ' +
      'that refuses writes and only reports them). Prefer doing simple things yourself; reserve this for ' +
      'longer autonomous tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        goal:    { type: 'string', description: 'The task for the agent to carry out end to end' },
        root:    { type: 'string', description: 'Workspace folder the tools are confined to (defaults to the server cwd)' },
        allowedCommands: { type: 'array', items: { type: 'string' }, description: 'run_command allowlist (defaults to a safe set)' },
      },
      required: ['goal'],
    },
  },
];

// ── Digest jobs ───────────────────────────────────────────────────────────────

const text    = t => ({ content: [{ type: 'text', text: t }] });
const failure = t => ({ content: [{ type: 'text', text: t }], isError: true });

function waitMs(seconds) {
  const s = Number.isFinite(seconds) ? seconds : DEFAULT_WAIT;
  return Math.min(Math.max(s, 0), MAX_WAIT) * 1000;
}

function jobReply(queue, job, model) {
  if (job.status === 'done') {
    const r = job.result;
    const footer = r.chunks
      ? `\n\n— motkra (${model}): read ${r.rawChars.toLocaleString('en-US')} chars in ${r.chunks} chunk(s), ${r.seconds}s`
      : '';
    return text(r.text + footer);
  }
  if (job.status === 'failed') return failure(`motkra_digest failed (${job.id}): ${job.error}`);
  const where = job.status === 'queued'
    ? `queued behind ${queue.position(job)} job(s)`
    : job.progress || 'running';
  return text(
    `Still working in the background (${where}). job_id: ${job.id}\n` +
    'Carry on with other work and call motkra_result with this job_id later.'
  );
}

// ── MCP request handler ───────────────────────────────────────────────────────

/** deps: { chat, redact, root, model, queue } — injectable for tests. */
function createHandler(deps) {
  const queue = deps.queue ?? new JobQueue();

  return async function handleRequest(req) {
    const { id, method, params } = req;

    // Notifications have no id — no response expected
    if (id === undefined || id === null) return null;

    const ok  = result  => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {

      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities:    { tools: {} },
          serverInfo:      { name: 'motkra-mcp', version: '0.2.0' },
        });

      case 'ping':
        return ok({});

      case 'tools/list':
        return ok({ tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args = {} } = params ?? {};

        if (name === 'motkra_digest') {
          const { paths, question, pattern, max_words: maxWords, wait_seconds: wait } = args;
          if (!question) return err(-32602, '"question" is required');
          try {
            readInputs(paths, deps.root, pattern); // fail fast on bad paths instead of inside the job
          } catch (e) {
            return ok(failure(`motkra_digest: ${e.message}`));
          }
          const spec = { paths, question, pattern, maxWords: maxWords || 150 };
          const job = queue.submit(question, j => digest(spec, { ...deps, onProgress: p => { j.progress = p; } }), spec);
          return ok(jobReply(queue, await queue.wait(job, waitMs(wait)), deps.model));
        }

        if (name === 'motkra_result') {
          const job = queue.get(args.job_id);
          if (!job) return ok(failure(`Unknown job_id: ${args.job_id}`));
          return ok(jobReply(queue, await queue.wait(job, waitMs(args.wait_seconds)), deps.model));
        }

        if (name === 'ollama_chat') {
          const { model, prompt, system } = args;
          if (!model || !prompt) return err(-32602, '"model" and "prompt" are required');
          try {
            return ok(text(await ollamaChat(model, [{ role: 'user', content: prompt }], system)));
          } catch (e) {
            return ok(failure(`Ollama error: ${e.message}`));
          }
        }

        if (name === 'ollama_list_models') {
          try {
            const models = await ollamaListModels();
            return ok(text(models.length
              ? `Available Ollama models:\n${models.map(m => `• ${m}`).join('\n')}`
              : 'No models found. Is Ollama running? Try: ollama serve'));
          } catch (e) {
            return ok(failure(`Ollama error: ${e.message}`));
          }
        }

        // ── GitHub tools ─────────────────────────────────────────────────────
        const gtoken = deps.githubToken ?? process.env.GITHUB_TOKEN ?? '';

        if (name === 'github_list_issues') {
          if (!args.repo) return err(-32602, '"repo" is required (owner/repo)');
          try { return ok(text(await gh.listIssues(args.repo, { state: args.state, labels: args.labels, per_page: args.per_page, pull: args.pull }, gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'github_get_issue') {
          if (!args.repo || !args.number) return err(-32602, '"repo" and "number" are required');
          try { return ok(text(await gh.getIssue(args.repo, Number(args.number), gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'github_create_issue') {
          if (!args.repo) return err(-32602, '"repo" is required');
          try { return ok(text(await gh.createIssue(args.repo, { title: args.title, body: args.body, labels: args.labels }, gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'github_comment') {
          if (!args.repo || !args.number || !args.body) return err(-32602, '"repo", "number" and "body" are required');
          try { return ok(text(await gh.comment(args.repo, Number(args.number), args.body, gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'github_pr_diff') {
          if (!args.repo || !args.number) return err(-32602, '"repo" and "number" are required');
          try { return ok(text(await gh.getPRDiff(args.repo, Number(args.number), gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'github_pr_files') {
          if (!args.repo || !args.number) return err(-32602, '"repo" and "number" are required');
          try { return ok(text(await gh.listPRFiles(args.repo, Number(args.number), gtoken))); }
          catch (e) { return ok(failure(e.message)); }
        }

        if (name === 'motkra_task') {
          if (!args.goal) return err(-32602, '"goal" is required');
          try {
            const r = await runTask(args.goal, { root: args.root, allowedCommands: args.allowedCommands });
            return ok(text(r.transcript));
          } catch (e) {
            return ok(failure(e.message));
          }
        }

        return err(-32601, `Unknown tool: ${name}`);
      }

      default:
        return err(-32601, `Method not found: ${method}`);
    }
  };
}

// ── Connection handler (shared by stdio and TCP) ──────────────────────────────

function handleConnection(input, writeFn, handleRequest) {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try { req = JSON.parse(trimmed); } catch { return; }
    const resp = await handleRequest(req);
    if (resp) writeFn(JSON.stringify(resp) + '\n');
  });
  return rl;
}

function main() {
  const root = process.env.MOTKRA_ROOT ?? process.cwd();
  const handleRequest = createHandler({
    chat:   digestChat,
    redact: pythonRedact,
    root,
    model:  DIGEST_MODEL,
    queue:  new DiskJobs({ env: { MOTKRA_ROOT: root } }),   // jobs outlive this process
  });

  // ── Stdio transport ─────────────────────────────────────────────────────────

  const stdioRl = handleConnection(process.stdin, s => process.stdout.write(s), handleRequest);
  stdioRl.on('close', () => process.exit(0));

  // ── TCP transport (optional) ────────────────────────────────────────────────

  const tcpPort = process.env.MOTKRA_MCP_PORT ? parseInt(process.env.MOTKRA_MCP_PORT, 10) : null;

  if (tcpPort) {
    const server = net.createServer(socket => {
      const rl = handleConnection(socket, s => { if (!socket.destroyed) socket.write(s); }, handleRequest);
      socket.on('error', () => rl.close());
      socket.on('close', () => rl.close());
    });
    server.listen(tcpPort, '127.0.0.1', () => {
      process.stderr.write(`[motkra-mcp] TCP server on 127.0.0.1:${tcpPort}\n`);
    });
    server.on('error', e => process.stderr.write(`[motkra-mcp] TCP error: ${e.message}\n`));
  }

  process.stderr.write('[motkra-mcp] MCP server ready (stdio)\n');
}

if (require.main === module) main();

module.exports = { createHandler, TOOLS };
