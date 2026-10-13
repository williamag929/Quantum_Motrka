'use strict';

const path  = require('path');
const fs    = require('fs');
const { runAllowed, tokenize } = require('./core/command');
const { isMutatingGit } = require('./core/branch-guard');
const { formatNoMatchHint } = require('./core/fuzzy-match');
const { guardContext } = require('./core/context-guard');
const gh = require('./core/github');

let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }

const os = require('os');

const { default: Anthropic } = require('@anthropic-ai/sdk');
const { streamKimi } = require('./clients/kimi');
let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const { searchWeb, fetchUrl } = require('./core/web');

// ── Tools Claude can call ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file. Paths are relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file with new content.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Complete file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'str_replace',
    description:
      'Replace an exact string inside a file. ' +
      'old_text must match exactly (whitespace included). ' +
      'Use for targeted edits without rewriting the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path:     { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to find' },
        new_text: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_files',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to workspace root.' }
      }
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace. ' +
      'Use for npm, pytest, git, python, node, etc. ' +
      'Only executables in motkra.allowedCommands are permitted. No shell: pipes, && and redirection are not supported.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Full command string to execute' },
        cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' }
      },
      required: ['cmd']
    }
  },
  {
    name: 'web_search',
    description:
      'Search the web for information. Use for current events, library docs, error messages, ' +
      'or anything not in the local codebase. Returns up to 5 results.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the text content of a URL (HTML stripped). ' +
      'Useful for reading documentation pages, GitHub issues, or any web resource. ' +
      'Returns up to 10,000 characters.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including https://' }
      },
      required: ['url']
    }
  },
  {
    name: 'take_screenshot',
    description:
      'Capture a screenshot of the active VS Code editor and attach it as an image. ' +
      'Requires motkra.allowScreenshot = true.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'github',
    description:
      'Work with a GitHub repo: list or read issues and PRs, create issues, comment, and get a PR\'s diff or changed files. ' +
      'Use action="list_issues" (set pull=true for PRs), "get_issue" (needs number), "create_issue" (needs title), ' +
      '"comment" (needs number + body), "pr_diff" (needs number), or "pr_files" (needs number). ' +
      'repo is "owner/name". Reading public repos works without a token; set motkra.githubToken for private repos, writes, and a higher rate limit.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_issues', 'get_issue', 'create_issue', 'comment', 'pr_diff', 'pr_files'], description: 'What to do' },
        repo:   { type: 'string', description: 'owner/repo, e.g. williamag929/Quantum_Motrka' },
        number: { type: 'integer', description: 'Issue or PR number (for get_issue, comment, pr_diff, pr_files)' },
        title:  { type: 'string', description: 'Issue title (for create_issue)' },
        body:   { type: 'string', description: 'Issue/comment body, markdown (for create_issue, comment)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels (for create_issue)' },
        state:  { type: 'string', enum: ['open', 'closed', 'all'], description: 'For list_issues (default open)' },
        pull:   { type: 'boolean', description: 'For list_issues: true lists pull requests instead of issues' },
      },
      required: ['action', 'repo'],
    },
  },
];

// ── Workspace helpers ─────────────────────────────────────────────────────────

function workspaceRoot() {
  return fs.realpathSync(vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd());
}

/** @param {string} [root]  the session's root: the workspace, or Motkra's worktree once it moved there */
function resolvePath(p, root = workspaceRoot()) {
  const full = path.resolve(root, p);
  const isWithinRoot = candidate => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };

  if (!isWithinRoot(full)) throw new Error('File paths must stay inside the workspace.');

  let existing = full;
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Could not resolve a path inside the workspace.');
      existing = parent;
    }
  }
  if (!isWithinRoot(fs.realpathSync(existing))) {
    throw new Error('File paths must stay inside the workspace.');
  }
  return full;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

/**
 * @param {string}   name
 * @param {Object}   input
 * @param {Object}   opts
 * @param {Function} [opts.onDiffRequest]     (id, filePath, before, after) → Promise<boolean>
 * @param {Function} [opts.onWriteAccessRequest] () → Promise<boolean>
 * @param {string[]} [opts.allowedCommands]
 * @param {number}   [opts.terminalTimeout]   seconds
 */
/**
 * Ask whether Motkra may change things at `target`. The answer may move the session to another
 * root (Motkra's own worktree), in which case the change must be made there instead.
 * @returns {Promise<{ok:boolean, root?:string, message?:string}>}
 */
async function requestWrite(onWriteAccessRequest, target) {
  if (!onWriteAccessRequest) return { ok: false };
  const answer = await onWriteAccessRequest(target);
  return typeof answer === 'boolean' ? { ok: answer } : answer;
}

const noteOf = access => (access.message ? `\n(${access.message})` : '');

async function executeTool(name, input, opts = {}) {
  const { onDiffRequest, onWriteAccessRequest, allowedCommands, terminalTimeout, onActionApproval } = opts;
  // Cline-style per-category gate for read / web / command tools. When no callback
  // is wired (unit tests, the daemon's own executor), fall back to allowing — so this
  // changes nothing until the extension passes onActionApproval.
  const approveAction = (category, describe) =>
    onActionApproval ? onActionApproval(category, describe) : Promise.resolve(true);
  let root = opts.root ?? workspaceRoot();

  switch (name) {

    case 'read_file': {
      if (!(await approveAction('read', `read the file ${input.path}`)))
        return `Read not approved by user: ${input.path}`;
      return fs.readFileSync(resolvePath(input.path, root), 'utf8');
    }

    case 'write_file': {
      const access = await requestWrite(onWriteAccessRequest, resolvePath(input.path, root));
      if (!access.ok) return access.message ?? `Write access denied: ${input.path}`;
      if (access.root) root = access.root;
      const full = resolvePath(input.path, root);
      let before = '';
      let exists = true;
      try { before = fs.readFileSync(full, 'utf8'); }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        exists = false;
      }

      if (exists && before === input.content) return `No changes needed: ${input.path}${noteOf(access)}`;
      const id       = nextDiffId();
      const accepted = await onDiffRequest?.(id, input.path, before, input.content);
      if (!accepted) return `Edit rejected by user: ${input.path}`;

      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, input.content, 'utf8');
      return `Wrote ${input.path}${noteOf(access)}`;
    }

    case 'str_replace': {
      const access = await requestWrite(onWriteAccessRequest, resolvePath(input.path, root));
      if (!access.ok) return access.message ?? `Write access denied: ${input.path}`;
      if (access.root) root = access.root;
      const full    = resolvePath(input.path, root);
      const content = fs.readFileSync(full, 'utf8');
      if (!content.includes(input.old_text)) {
        // Actionable self-correction feedback (whitespace vs. genuinely absent,
        // plus the closest real section) so the model can fix old_string and retry
        // on its own instead of failing or repeating the same bad string.
        return formatNoMatchHint(input.old_text, content, input.path);
      }
      const newContent = content.replace(input.old_text, input.new_text);

      if (content === newContent) return `No changes needed: ${input.path}${noteOf(access)}`;
      const id       = nextDiffId();
      const accepted = await onDiffRequest?.(id, input.path, content, newContent);
      if (!accepted) return `Edit rejected by user: ${input.path}`;

      fs.writeFileSync(full, newContent, 'utf8');
      return `Edited ${input.path}${noteOf(access)}`;
    }

    case 'list_files': {
      if (!(await approveAction('read', `list files in ${input.path || 'the workspace root'}`)))
        return `Listing not approved by user: ${input.path || 'workspace root'}`;
      const dir     = input.path ? resolvePath(input.path, root) : root;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    }

    case 'run_command': {
      const { cmd, cwd: relCwd } = input;
      if (!(await approveAction('commands', `run the command \`${cmd}\``)))
        return `Command not approved by user: ${cmd}`;
      const cfg     = vscode?.workspace?.getConfiguration('motkra');
      const allowed = allowedCommands
        ?? cfg?.get('allowedCommands')
        ?? ['npm', 'npx', 'python', 'python3', 'pytest', 'git', 'node'];
      const timeoutMs = ((terminalTimeout ?? cfg?.get('terminalTimeout') ?? 30)) * 1000;
      let workdir     = relCwd ? resolvePath(relCwd, root) : root;
      // git commands that change the repository obey the same branch/worktree rules as file writes.
      let argv = [];
      try { argv = tokenize(String(cmd ?? '')); } catch { /* runAllowed reports the parse error */ }
      let note = '';
      if (isMutatingGit(argv)) {
        const access = await requestWrite(onWriteAccessRequest, workdir);
        if (!access.ok) return access.message ?? `Not allowed to change the repository here: ${cmd}`;
        if (access.root) workdir = relCwd ? resolvePath(relCwd, access.root) : access.root;
        note = noteOf(access);
      }
      return (await runAllowed(String(cmd ?? ''), { cwd: workdir, allowed, timeoutMs })) + note;
    }

    case 'web_search': {
      if (!(await approveAction('web', `search the web for "${input.query}"`)))
        return `Web search not approved by user: ${input.query}`;
      const cfg      = vscode?.workspace?.getConfiguration('motkra');
      const braveKey = cfg?.get('braveSearchKey') ?? '';
      return await searchWeb(input.query, braveKey);
    }

    case 'fetch_url': {
      if (!(await approveAction('web', `fetch the URL ${input.url}`)))
        return `Fetch not approved by user: ${input.url}`;
      return await fetchUrl(input.url);
    }

    case 'take_screenshot': {
      const cfg = vscode?.workspace?.getConfiguration('motkra');
      if (!cfg?.get('allowScreenshot', false)) {
        return 'Screenshot is disabled. Set motkra.allowScreenshot = true in VS Code settings to enable.';
      }
      if (!vscode) return 'Screenshot requires the VS Code extension environment.';

      const before = Date.now();
      await vscode.commands.executeCommand('workbench.action.screenshot');

      // Wait for the file to be written to disk
      await new Promise(r => setTimeout(r, 1500));

      // VS Code saves screenshots to the OS temp directory as vscode-screenshot-*.png
      const tmpDir  = os.tmpdir();
      let newest    = null;
      let newestTs  = 0;
      try {
        for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.match(/\.(png|jpg)$/i)) continue;
          const full = path.join(tmpDir, e.name);
          const stat = fs.statSync(full);
          if (stat.mtimeMs > before && stat.mtimeMs > newestTs) {
            newestTs = stat.mtimeMs;
            newest   = full;
          }
        }
      } catch { /* temp dir unreadable */ }

      if (!newest) {
        return 'Screenshot saved, but could not locate the file automatically. Try sharing the path manually.';
      }

      const data = fs.readFileSync(newest).toString('base64');
      const mime = newest.endsWith('.png') ? 'image/png' : 'image/jpeg';
      // Return image content block — handled by the agentic loop
      return [{ type: 'image', source: { type: 'base64', media_type: mime, data } }];
    }

    case 'github': {
      const cfg      = vscode?.workspace?.getConfiguration('motkra');
      const token    = cfg?.get('githubToken') ?? '';
      const { action, repo } = input;
      if (!repo) return 'github: "repo" is required (owner/name).';
      try {
        switch (action) {
          case 'list_issues':
            return await gh.listIssues(repo, { state: input.state, labels: input.labels, pull: input.pull }, token);
          case 'get_issue':
            if (input.number == null) return 'github get_issue: "number" is required.';
            return await gh.getIssue(repo, Number(input.number), token);
          case 'create_issue':
            return await gh.createIssue(repo, { title: input.title, body: input.body, labels: input.labels }, token);
          case 'comment':
            if (input.number == null || !input.body) return 'github comment: "number" and "body" are required.';
            return await gh.comment(repo, Number(input.number), input.body, token);
          case 'pr_diff':
            if (input.number == null) return 'github pr_diff: "number" is required.';
            return await gh.getPRDiff(repo, Number(input.number), token);
          case 'pr_files':
            if (input.number == null) return 'github pr_files: "number" is required.';
            return await gh.listPRFiles(repo, Number(input.number), token);
          default:
            return `github: unknown action "${action}". Use list_issues, get_issue, create_issue, comment, pr_diff, or pr_files.`;
        }
      } catch (err) {
        return `github ${action} failed: ${err.message}`;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agentic loop ─────────────────────────────────────────────────────────────

// Monotonic diff-id counter. Timestamps alone can collide when two writes land in
// the same millisecond (chat multi-tool turns, or subtasks in /plan); a duplicate
// id would overwrite the pending resolver and hang that edit forever.
let _diffSeq = 0;
const nextDiffId = () => `diff_${Date.now()}_${++_diffSeq}`;

/**
 * Run Claude with workspace tools until it produces a final answer.
 *
 * @param {Array}    history          Conversation so far [{role, content}]
 * @param {string}   system           System prompt string
 * @param {Function} onToken          Called with each streamed text token
 * @param {Function} onTool           Called when a tool fires (name, input)
 * @param {Function} onDone           Called with full assistant text when finished
 * @param {Function} [onDiffRequest]  Called before a file write; returns Promise<boolean>
 * @param {Function} [onUsage]        Called with {inputTokens, outputTokens} after each LLM turn
 * @param {Object}   [toolOpts]       Forwarded to executeTool (allowedCommands, terminalTimeout)
 * @param {Function} [onThinking]     Called with adaptive-thinking text
 * @param {Function} [onCompact]      Called with {droppedChars} when the context is auto-compacted (20B-2)
 */
async function runAgent(history, system, onToken, onTool, onDone, onDiffRequest, onUsage, toolOpts, onThinking, onCompact) {
  let messages = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const cfg   = vscode?.workspace?.getConfiguration('motkra');
  const model = cfg?.get('claudeModel') ?? 'claude-opus-4-7';
  const maxIterations = Math.max(1, Number(cfg?.get('maxAgentIterations') ?? 25));

  let fullText = '';

  for (let i = 0; i < maxIterations; i++) {
    // 20B-2: keep the request inside the model's context window instead of
    // letting a long turn blow past it mid-task. Collapses old tool output.
    const guard = guardContext(messages);
    if (guard.needsCompact) {
      messages = guard.messages;
      onCompact?.({ droppedChars: guard.droppedChars, tokens: guard.tokens });
    }

    const stream = getClient().messages.stream({
      model,
      max_tokens:    16000,
      thinking:      { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      tools:         TOOLS,
      system:        [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages
    });

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        onToken(event.delta.text);
        fullText += event.delta.text;
      } else if (event.delta.type === 'thinking_delta' && onThinking) {
        // Hidden reasoning from adaptive thinking — surfaced to a collapsible block, not the answer.
        onThinking(event.delta.thinking ?? '');
      }
    }

    const response = await stream.finalMessage();

    if (onUsage) {
      onUsage({
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      });
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      onTool(block.name, block.input);
      let result;
      try {
        result = await executeTool(block.name, block.input, {
          onDiffRequest,
          ...toolOpts
        });
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      // Array result means image/multi-part content (e.g. screenshot); string otherwise
      const content = Array.isArray(result) ? result : String(result);
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    }
    messages.push({ role: 'user', content: results });
  }

  onDone(fullText);
}

function toKimiTools() {
  return TOOLS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Run Kimi with the same workspace tools and per-change review used by Claude.
 */
async function runKimiAgent(history, system, onToken, onTool, onDone, onDiffRequest, toolOpts, onThinking, onCompact) {
  let messages = [
    { role: 'system', content: system },
    ...history.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
  ];
  const tools = toKimiTools();
  const cfg   = vscode?.workspace?.getConfiguration('motkra');
  const maxIterations = Math.max(1, Number(cfg?.get('maxAgentIterations') ?? 25));
  let fullText = '';

  for (let i = 0; i < maxIterations; i++) {
    // 20B-2: compact old tool output before the request overflows Kimi's context.
    const guard = guardContext(messages, { window: 128_000 });
    if (guard.needsCompact) {
      messages = guard.messages;
      onCompact?.({ droppedChars: guard.droppedChars, tokens: guard.tokens });
    }

    const response = await streamKimi(messages, onToken, tools, onThinking);
    fullText += response.text;
    if (!response.toolCalls.length) break;

    messages.push({
      role: 'assistant',
      content: response.text || null,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const name = call.function.name;
      let result;
      try {
        const input = JSON.parse(call.function.arguments);
        onTool(name, input);
        result = await executeTool(name, input, { onDiffRequest, ...toolOpts });
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: Array.isArray(result) ? JSON.stringify(result) : String(result),
      });
    }
  }

  onDone(fullText);
}

module.exports = { executeTool, runAgent, runKimiAgent };
