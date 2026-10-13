'use strict';

// Where may Motkra write? A rule in the prompt can be skipped; this check cannot.
// Writes (and git commands that change the repo) are refused on a protected branch, and in the
// main checkout of a repo whose rules ask agents to use worktrees. The caller then offers to
// create Motkra's own worktree + branch and continues the task there.

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_PROTECTED = ['main', 'master', 'develop', 'trunk'];

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/** Facts about the checkout at `cwd` (null when it is not a git repo). */
function inspect(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const gitDir    = path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']) ?? '.git');
  const commonDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']) ?? '.git');
  const originHead = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return {
    top: path.resolve(top),
    branch: git(cwd, ['branch', '--show-current']) || null,           // null = detached HEAD
    linkedWorktree: gitDir.toLowerCase() !== commonDir.toLowerCase(),
    mainTop: path.resolve(path.dirname(commonDir)),
    defaultBranch: originHead ? originHead.replace(/^origin\//, '') : null,
  };
}

/**
 * Decide whether writing in `cwd` is allowed.
 * @param {string} cwd
 * @param {{protectedBranches?:string[], requireWorktree?:boolean}} policy
 * @returns {{ok:true, info?:object} | {ok:false, reason:string, info:object}}
 */
function checkWrite(cwd, { protectedBranches = DEFAULT_PROTECTED, requireWorktree = false } = {}) {
  const info = inspect(cwd);
  if (!info) return { ok: true };
  const protectedSet = new Set([...protectedBranches, info.defaultBranch].filter(Boolean).map(b => b.toLowerCase()));
  if (info.branch && protectedSet.has(info.branch.toLowerCase())) {
    return { ok: false, info, reason: `the branch \`${info.branch}\` is protected` };
  }
  if (requireWorktree && !info.linkedWorktree) {
    return { ok: false, info, reason: `this is the main checkout${info.branch ? ` (branch \`${info.branch}\`)` : ''} and the project's rules ask each agent to work in its own worktree` };
  }
  return { ok: true, info };
}

function slug(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

/**
 * The worktree folder name the project's rules give Motkra:
 *   1. a line naming Motkra with a …\wt\<name> path  (e.g. "Motkra: C:\projects\serpi\wt\api-motkra")
 *   2. the pattern other agents use (wt\api-claude, wt\api-copilot → api-motkra)
 * Only the name is taken: the folder goes next to the repo on this machine, since the rules may
 * spell another drive or user folder.
 */
function worktreeNameFromRules(rulesText) {
  const text = String(rulesText ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (!/motkra/i.test(line)) continue;
    const m = line.match(/[\\/]wt[\\/]([\w.-]+)/i);
    if (m) return m[1];
  }
  const sibling = text.match(/[\\/]wt[\\/]([\w.-]+?)-(?:claude|copilot|codex|gemini|cursor)\b/i);
  return sibling ? `${sibling[1]}-motkra` : null;
}

/** Where Motkra's worktree goes: <parent of repo>/wt/<name>, branch motkra/<task>. */
function suggestWorktree(info, task, rulesText = '') {
  const name = worktreeNameFromRules(rulesText) ?? `${path.basename(info.mainTop)}-motkra`;
  return {
    dir: path.join(path.dirname(info.mainTop), 'wt', name),
    branch: `motkra/${slug(task)}`,
    base: info.branch ?? 'HEAD',
  };
}

/** Create (or reuse) the worktree. Returns its directory. Throws with git's message on failure. */
function createWorktree(info, { dir, branch, base }) {
  if (fs.existsSync(dir)) {
    const there = inspect(dir);
    if (there?.linkedWorktree && there.mainTop.toLowerCase() === info.mainTop.toLowerCase()) {
      // Reuse Motkra's existing worktree: switch it to the new task branch.
      const exists = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      execFileSync('git', ['-C', dir, 'checkout', ...(exists ? [branch] : ['-b', branch, base])],
        { windowsHide: true, stdio: 'pipe' });
      return dir;
    }
    throw new Error(`${dir} already exists and is not a worktree of this repository.`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['-C', info.mainTop, 'worktree', 'add', dir, '-b', branch, base], { windowsHide: true, stdio: 'pipe' });
  return dir;
}

// git subcommands that change the repository: guarded like file writes.
const MUTATING_GIT = new Set(['commit', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'push', 'pull', 'cherry-pick',
  'revert', 'stash', 'tag', 'am', 'apply', 'rm', 'mv', 'restore', 'clean']);

function isMutatingGit(argv) {
  return argv.length > 1 && /^git(\.exe)?$/i.test(path.basename(argv[0])) && MUTATING_GIT.has(argv[1].toLowerCase());
}

module.exports = { DEFAULT_PROTECTED, inspect, checkWrite, suggestWorktree, worktreeNameFromRules, createWorktree, isMutatingGit, slug };
