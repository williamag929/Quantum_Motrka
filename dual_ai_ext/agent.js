'use strict';

const path  = require('path');
const fs    = require('fs');
const { runAllowed, tokenize } = require('./core/command');
const { isMutatingGit } = require('./core/branch-guard');

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
  }
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
  const { onDiffRequest, onWriteAccessRequest, allowedCommands, terminalTimeout } = opts;
  let root = opts.root ?? workspaceRoot();

  switch (name) {

    case 'read_file': {
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
      const id       = `diff_${Date.now()}`;
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
        throw new Error(`Text not found in ${input.path}: "${input.old_text.slice(0, 60)}"`);
      }
      const newContent = content.replace(input.old_text, input.new_text);

      if (content === newContent) return `No changes needed: ${input.path}${noteOf(access)}`;
      const id       = `diff_${Date.now()}`;
      const accepted = await onDiffRequest?.(id, input.path, content, newContent);
      if (!accepted) return `Edit rejected by user: ${input.path}`;

      fs.writeFileSync(full, newContent, 'utf8');
      return `Edited ${input.path}${noteOf(access)}`;
    }

    case 'list_files': {
      const dir     = input.path ? resolvePath(input.path, root) : root;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    }

    case 'run_command': {
      const { cmd, cwd: relCwd } = input;
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
      const cfg      = vscode?.workspace?.getConfiguration('motkra');
      const braveKey = cfg?.get('braveSearchKey') ?? '';
      return await searchWeb(input.query, braveKey);
    }

    case 'fetch_url': {
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agentic loop ─────────────────────────────────────────────────────────────

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
 */
async function runAgent(history, system, onToken, onTool, onDone, onDiffRequest, onUsage, toolOpts) {
  const messages = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const cfg   = vscode?.workspace?.getConfiguration('motkra');
  const model = cfg?.get('claudeModel') ?? 'claude-opus-4-7';

  let fullText = '';

  for (let i = 0; i < 10; i++) {
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
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        onToken(event.delta.text);
        fullText += event.delta.text;
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
async function runKimiAgent(history, system, onToken, onTool, onDone, onDiffRequest, toolOpts) {
  const messages = [
    { role: 'system', content: system },
    ...history.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
  ];
  const tools = toKimiTools();
  let fullText = '';

  for (let i = 0; i < 10; i++) {
    const response = await streamKimi(messages, onToken, tools);
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
