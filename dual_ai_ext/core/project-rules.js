'use strict';

// Project instructions that every agent must follow, loaded the way Claude Code loads CLAUDE.md.
// Rules often live one file away ("protocol: see docs/COWORK.md"), so Markdown files that the
// instruction files mention are included too — one level deep, size-capped.

const fs   = require('fs');
const path = require('path');

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'claude.md', '.github/copilot-instructions.md'];
const MAX_FILE_CHARS  = 15_000;
const MAX_TOTAL_CHARS = 45_000;
const MAX_REFERENCED  = 6;
const MD_REF = /(?:^|[\s(`'"[])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.md)\b/g;

function readCapped(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : text;
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Markdown files inside `root` mentioned in `text`, relative to `baseDir` or to the root. */
function referencedFiles(text, baseDir, root) {
  const found = [];
  for (const m of text.matchAll(MD_REF)) {
    for (const candidate of [path.resolve(baseDir, m[1]), path.resolve(root, m[1])]) {
      if (isInside(root, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/**
 * @param {string}   root     workspace folder
 * @param {string[]} [skip]   absolute paths already in the prompt (e.g. the selected agent's file)
 * @returns {{files:string[], text:string}}  `text` is '' when the project has no instructions
 */
function loadProjectRules(root, skip = []) {
  if (!root || !fs.existsSync(root)) return { files: [], text: '' };
  const seen = new Set(skip.map(f => path.resolve(f).toLowerCase()));
  const parts = [];
  let total = 0;

  const add = file => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || total >= MAX_TOTAL_CHARS) return null;
    seen.add(key);
    let text;
    try { text = readCapped(file); } catch { return null; }
    text = text.slice(0, MAX_TOTAL_CHARS - total);
    total += text.length;
    parts.push({ file: path.relative(root, file).replace(/\\/g, '/'), text });
    return text;
  };

  const primary = [];
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      const text = add(file);
      if (text) primary.push({ file, text });
    }
  }
  let referenced = 0;
  for (const { file, text } of primary) {
    for (const ref of referencedFiles(text, path.dirname(file), root)) {
      if (referenced >= MAX_REFERENCED) break;
      if (add(ref)) referenced++;
    }
  }

  if (!parts.length) return { files: [], text: '' };
  const text =
    '# Project instructions\n' +
    'These come from the workspace and override your defaults. Follow them, including rules about ' +
    'branches, worktrees, ledgers and what not to touch. Read any other file they point to before acting.\n\n' +
    parts.map(p => `## ${p.file}\n\n${p.text.trim()}`).join('\n\n');
  return { files: parts.map(p => p.file), text };
}

/** Do the project's rules ask agents to work in git worktrees? */
function mentionsWorktrees(rulesText) {
  return /\bworktrees?\b/i.test(rulesText ?? '');
}

module.exports = { loadProjectRules, referencedFiles, mentionsWorktrees };
