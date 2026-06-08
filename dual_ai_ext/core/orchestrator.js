'use strict';

const { runAgent } = require('../agent');

let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }

const PLANNER_SYSTEM =
  'You are a task planning agent. Break the given goal into 2-6 concrete, independently-executable ' +
  'subtasks for a coding agent that has tools to read, write, and edit files plus run shell commands. ' +
  'Respond ONLY with valid JSON — no prose, no markdown fences: ' +
  '{"tasks":[{"id":"t1","title":"Short title (≤8 words)","prompt":"Full instruction for the subtask agent"},...]}. ' +
  'Subtasks run sequentially; earlier results are passed as context to later ones. ' +
  'Keep each title brief and action-oriented (e.g. "Scaffold API routes", "Write unit tests").';

/**
 * Ask Claude to break a goal into subtasks.
 * @returns {Promise<Array<{id:string, title:string, prompt:string}>>}
 */
async function planTask(goal, model) {
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client   = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens:    2048,
    thinking:      { type: 'adaptive' },
    output_config: { effort: 'high' },
    system:        PLANNER_SYSTEM,
    messages:      [{ role: 'user', content: goal }]
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Planner returned no JSON. Response: ' + text.slice(0, 200));

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0)
    throw new Error('Planner returned no tasks.');

  return parsed.tasks;
}

/**
 * Orchestrate a goal by planning then executing subtasks sequentially.
 *
 * @param {string}   goal
 * @param {string}   systemPrompt    Coding-agent system prompt shared by all subtasks
 * @param {Function} onPlanned       (tasks:[{id,title,prompt}]) — called once after planning
 * @param {Function} onTaskStart     (taskId)
 * @param {Function} onTaskToken     (taskId, text)
 * @param {Function} onTaskTool      (taskId, name, input)
 * @param {Function} onTaskDone      (taskId, output)
 * @param {Function} onTaskError     (taskId, errMsg)
 * @param {Function} onComplete      ()
 * @param {Object}   [opts]
 * @param {string}   [opts.model]
 * @param {number}   [opts.maxSubAgents]
 * @param {Object}   [opts.toolOpts]
 * @param {Function} [opts.isCancelled]              () → boolean
 * @param {Function} [opts.isPaused]                 (taskId) → boolean
 * @param {Function} [opts.onPauseResolved]          (taskId, resolveFn) — store resolver for later resume
 */
async function runOrchestration(
  goal, systemPrompt,
  onPlanned, onTaskStart, onTaskToken, onTaskTool, onTaskDone, onTaskError, onComplete,
  opts = {}
) {
  const cfg = vscode?.workspace?.getConfiguration('motkra');
  const model     = opts.model     ?? cfg?.get('claudeModel')   ?? 'claude-opus-4-7';
  const maxAgents = opts.maxSubAgents ?? cfg?.get('maxSubAgents') ?? 4;

  const tasks = (await planTask(goal, model)).slice(0, maxAgents);
  onPlanned(tasks);

  let priorContext = '';

  for (const task of tasks) {
    if (opts.isCancelled?.()) break;

    // Pause gate — waits until caller resolves via onPauseResolved
    if (opts.isPaused?.(task.id)) {
      await new Promise(resolve => opts.onPauseResolved?.(task.id, resolve));
    }

    if (opts.isCancelled?.()) break;

    onTaskStart(task.id);

    const prompt = priorContext
      ? `${task.prompt}\n\n---\nContext from completed subtasks:\n${priorContext}`
      : task.prompt;

    const history    = [{ role: 'user', content: prompt }];
    let   taskOutput = '';

    try {
      await runAgent(
        history,
        systemPrompt,
        text  => { onTaskToken(task.id, text); },
        (n,i) => onTaskTool(task.id, n, i),
        full  => { taskOutput = full; },
        null,   // no diff approval gate in subtasks
        null,
        opts.toolOpts ?? {}
      );
      onTaskDone(task.id, taskOutput);
      priorContext += `\n\n### ${task.title}\n${taskOutput.slice(0, 800)}`;
    } catch (err) {
      onTaskError(task.id, err.message);
      break;
    }
  }

  onComplete();
}

module.exports = { planTask, runOrchestration };
