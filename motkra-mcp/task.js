'use strict';

// Headless harness around the dual_ai_ext agentic loop, exposed to MCP clients
// (Claude Code, etc.) as the `motkra_task` tool. Claude delegates a whole coding
// task; Motkra runs its full tool loop (read/write/edit, run_command, web) and
// reports every action as text so the caller stays the supervisor.
//
// Auto-approval model (chosen deliberately): this runs with NO interactive UI, so
// every write is applied and every action logged, rather than blocking on a modal
// that can't appear. The MCP client that invoked the tool is trusted as the human.
// Set MOTKRA_TASK_REQUIRE_APPROVAL=1 to instead REFUSE writes and only report the
// planned diff (a dry-run) — safer if you ever expose this over TCP.

const path = require('path');

// The loop lives in the sibling extension package (which ships the Anthropic SDK).
// Requiring it lazily keeps motkra-mcp usable even if that package isn't installed.
// The resolver is injectable so tests can supply a fake loop (no network / API key).
function defaultResolver() {
  return require(path.join(__dirname, '..', 'dual_ai_ext', 'agent')).runAgent;
}
function loadRunAgent(resolver) {
  try {
    return resolver();
  } catch (e) {
    throw new Error(`Could not load the Motkra agent loop (${e.message}). ` +
      'Make sure dual_ai_ext is installed with its dependencies (npm install there).');
  }
}

const requireApproval = process.env.MOTKRA_TASK_REQUIRE_APPROVAL === '1';

/**
 * Run one agentic task to completion and return a transcript the caller can read.
 *
 * @param {string} goal        what the agent should do
 * @param {Object} [opts]
 * @param {string} [opts.root] workspace root the tools are confined to (default: process.cwd())
 * @param {string} [opts.system] override system prompt (default: concise autonomous coding prompt)
 * @param {string[]} [opts.allowedCommands] run_command allowlist
 * @param {Function} [opts._resolver] test seam: returns the runAgent function
 * @returns {Promise<{answer:string, transcript:string, toolsUsed:string[], ok:boolean}>}
 */
async function runTask(goal, opts = {}) {
  const root = opts.root ?? process.cwd();

  const system = opts.system ??
    'You are a coding agent. Carry the task through to the end using your tools: read the relevant ' +
    'files, make the edits, run the tests or build, and fix what fails. Work autonomously — only stop ' +
    'to ask if the request is genuinely ambiguous or a step is destructive and irreversible. When done, ' +
    'give a short summary of what you changed and how you verified it.';

  const transcript = [];
  const toolsUsed = [];
  const onTool = (name, input) => {
    toolsUsed.push(name);
    const brief = name === 'run_command' ? input.cmd
      : name === 'write_file' || name === 'str_replace' ? input.path
      : name === 'read_file' || name === 'list_files' ? (input.path ?? '.')
      : name === 'web_search' ? input.query
      : name === 'fetch_url' ? input.url
      : '';
    transcript.push(`▸ ${name}${brief ? ` ${brief}` : ''}`);
  };

  // Auto-approve every write; in dry-run mode refuse and record the intent instead.
  const onDiffRequest = async (id, filePath) => {
    if (requireApproval) {
      transcript.push(`✗ write REFUSED (dry-run): ${filePath}`);
      return false;
    }
    transcript.push(`✓ applied edit: ${filePath}`);
    return true;
  };

  // read / web / command tools: approve all (the MCP caller is the supervisor).
  const onActionApproval = async () => true;

  let answer = '';
  const toolOpts = {
    root,
    allowedCommands: opts.allowedCommands,
    onWriteAccessRequest: async () => ({ ok: true }),   // no branch guard in headless mode
    onActionApproval,
  };

  let ok = true;
  try {
    const run = loadRunAgent(opts._resolver ?? defaultResolver);
    await run(
      [{ role: 'user', content: goal }],
      system,
      tok => { answer += tok; },
      onTool,
      () => {},
      onDiffRequest,
      null,
      toolOpts
    );
  } catch (e) {
    ok = false;
    answer = answer ? `${answer}\n\n(error: ${e.message})` : `Error: ${e.message}`;
  }

  const header = requireApproval ? 'Motkra task (dry-run — writes refused):' : 'Motkra task:';
  const body = transcript.length ? `\n\n--- actions ---\n${transcript.join('\n')}` : '';
  return { answer, transcript: `${header} ${goal}${body}\n\n--- result ---\n${answer}`, toolsUsed, ok };
}

module.exports = { runTask };
