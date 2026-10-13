'use strict';

// Context-window guard for the agentic loop (20B-2).
//
// Every read_file / run_command result gets appended to `messages`, so a long
// tool-using turn grows until a request exceeds the model's context and the
// whole turn dies mid-task. We estimate tokens cheaply before each request and,
// when close to the limit, drop the *content* of the oldest tool_result blocks
// (the model has already acted on them) while keeping the original goal and the
// recent messages intact — collapsing text, never removing blocks, so the
// tool_use/tool_result pairing the API requires is preserved.
//
// Pure (no fs, no vscode) so it is unit-testable on its own.

const DEFAULT_WINDOW = 200_000;          // Opus/Sonnet/Kimi all clear this
const RESERVE        = 20_000;           // head-room for the reply (max_tokens is 16k)
const WARN_RATIO     = 0.8;              // compact once 80% of the budget is used

/** Rough token estimate (~4 chars/token for English+code). */
function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/** Total estimated input tokens across a messages array (strings or block arrays). */
function estimateMessagesTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b === 'string') chars += b.length;
        else if (typeof b?.text === 'string') chars += b.text.length;
        else if (typeof b?.content === 'string') chars += b.content.length;
        else if (b?.input) chars += JSON.stringify(b.input).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Compact a messages array in place of the whole history.
 *
 * Keeps the first two messages (system/goal) and the last `keepTail` messages
 * verbatim. For older messages, collapses any large tool output to a one-line
 * note — Anthropic `tool_result` blocks and OpenAI/Kimi `role:'tool'` messages
 * alike — preserving each block's `id`/`tool_use_id` so the API's tool pairing
 * still validates. Returns a NEW array (never mutates the input).
 *
 * @param {Array} messages
 * @param {{keepTail?:number, maxCharsPerBlock?:number}} [opts]
 * @returns {{messages:Array, droppedChars:number}}
 */
function compactMessages(messages, { keepTail = 8, maxCharsPerBlock = 500 } = {}) {
  if (messages.length <= keepTail) return { messages, droppedChars: 0 };
  const cut = messages.length - keepTail;
  let droppedChars = 0;

  const shrinkStr = s => {
    if (typeof s !== 'string' || s.length <= maxCharsPerBlock) return s;
    const note = `[compacted: ${s.length} chars of earlier tool output omitted to save context]`;
    droppedChars += s.length - note.length;
    return note;
  };

  const shrunk = messages.map((m, idx) => {
    if (idx < 2 || idx >= cut) return m;               // system/goal + recent stay intact

    // OpenAI/Kimi shape: a standalone tool message with string content.
    if (m.role === 'tool' && typeof m.content === 'string') {
      return { ...m, content: shrinkStr(m.content) };
    }
    // Anthropic shape: tool_result blocks inside a user message.
    if (Array.isArray(m.content)) {
      const content = m.content.map(b => {
        if (b?.type !== 'tool_result' || typeof b.content !== 'string') return b;
        if (b.content.length <= maxCharsPerBlock) return b;
        const note = `[compacted: ${b.content.length} chars of earlier tool output omitted to save context]`;
        droppedChars += b.content.length - note.length;
        return { ...b, content: note };
      });
      return { ...m, content };
    }
    return m;
  });

  return { messages: shrunk, droppedChars };
}

/**
 * Decide whether the next request needs compaction.
 *
 * @param {Array}  messages
 * @param {{window?:number, reserve?:number, warnRatio?:number, keepTail?:number}} [opts]
 * @returns {{tokens:number, budget:number, needsCompact:boolean, overBudget:boolean,
 *            messages:Array, droppedChars:number}}
 */
function guardContext(messages, opts = {}) {
  const window    = opts.window    ?? DEFAULT_WINDOW;
  const reserve   = opts.reserve   ?? RESERVE;
  const warnRatio = opts.warnRatio ?? WARN_RATIO;
  const budget    = Math.max(window - reserve, 1);

  const raw   = estimateMessagesTokens(messages);
  const over  = raw >= budget;
  const warn  = raw >= budget * warnRatio;

  if (!warn) {
    return { tokens: raw, budget, needsCompact: false, overBudget: over, messages, droppedChars: 0 };
  }

  const { messages: compacted, droppedChars } = compactMessages(messages, {
    keepTail: opts.keepTail,
  });
  const after = estimateMessagesTokens(compacted);
  return {
    tokens: after, budget, needsCompact: true,
    overBudget: after >= budget,
    messages: compacted, droppedChars,
  };
}

module.exports = {
  DEFAULT_WINDOW, RESERVE, WARN_RATIO,
  estimateTokens, estimateMessagesTokens,
  compactMessages, guardContext,
};

