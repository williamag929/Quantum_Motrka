'use strict';

// Which model providers Motkra may use, chosen by the user in ⚙ Settings.
// Stored in ~/.motkra/settings.json. A provider is *available* when it is enabled and
// configured (API key present). pickProvider() applies the choice to a routing plan
// without ever trading privacy for availability.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DEFAULT_ENDPOINT = { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY' };
const MODEL_RE   = /^[\w.\-:\/]{1,200}$/;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// `defaultModel` is the first-run value; the user's choice (settings.models) wins over it.
const PROVIDERS = {
  local:  { label: 'Ollama (local)',     engine: 'gemma', defaultModel: () => process.env.GEMMA_MODEL || 'gemma4:e2b',
            configured: () => true, needs: () => '' },
  claude: { label: 'Claude (Anthropic)', engine: 'claude', defaultModel: () => 'claude-opus-4-7',
            configured: () => !!process.env.ANTHROPIC_API_KEY, needs: () => 'ANTHROPIC_API_KEY' },
  // The OpenAI-compatible lane: NVIDIA by default, any other endpoint through settings.endpoint.
  nvidia: { label: 'NVIDIA (Kimi)',      engine: 'kimi', defaultModel: () => process.env.KIMI_MODEL || 'moonshotai/kimi-k2.6',
            configured: s => !!process.env[endpointFor(s).apiKeyEnv], needs: s => endpointFor(s).apiKeyEnv },
};

const TASK_KINDS = ['chat', 'agent', 'quick'];
// mode 'manual': the brain's local/cloud decision plus cloudPreference (how it always worked).
// mode 'auto':   `tasks` says which provider answers each kind of task (see classifyTask).
const DEFAULTS = {
  providers: { local: true, claude: true, nvidia: true }, cloudPreference: 'claude',
  mode: 'manual', tasks: { chat: 'claude', agent: 'claude', quick: 'local' },
};

function file() {
  return path.join(process.env.MOTKRA_DIR ?? path.join(os.homedir(), '.motkra'), 'settings.json');
}

/** A usable base URL (no trailing slash): https anywhere, plain http only for this computer. */
function cleanBaseUrl(value) {
  try {
    const u = new URL(String(value));
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return String(value).trim().replace(/\/+$/, '');
  } catch {}
  return null;
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  const providers = { ...DEFAULTS.providers };
  for (const k of Object.keys(providers)) if (typeof saved.providers?.[k] === 'boolean') providers[k] = saved.providers[k];
  const cloudPreference = ['claude', 'nvidia'].includes(saved.cloudPreference) ? saved.cloudPreference : DEFAULTS.cloudPreference;
  const models = {};
  for (const k of Object.keys(PROVIDERS)) if (MODEL_RE.test(saved.models?.[k] ?? '')) models[k] = saved.models[k];
  const endpoint = {
    baseUrl:   cleanBaseUrl(saved.endpoint?.baseUrl) ?? DEFAULT_ENDPOINT.baseUrl,
    apiKeyEnv: KEY_ENV_RE.test(saved.endpoint?.apiKeyEnv ?? '') ? saved.endpoint.apiKeyEnv : DEFAULT_ENDPOINT.apiKeyEnv,
  };
  const mode = ['manual', 'auto'].includes(saved.mode) ? saved.mode : DEFAULTS.mode;
  const tasks = { ...DEFAULTS.tasks };
  for (const k of TASK_KINDS) if (saved.tasks?.[k] in PROVIDERS) tasks[k] = saved.tasks[k];
  return { providers, cloudPreference, models, endpoint, mode, tasks };
}

/** Merge a partial update from the UI, save it, and return the new settings. */
function save(update = {}) {
  const cur = load();
  for (const k of Object.keys(cur.providers)) {
    if (typeof update.providers?.[k] === 'boolean') cur.providers[k] = update.providers[k];
  }
  if (['claude', 'nvidia'].includes(update.cloudPreference)) cur.cloudPreference = update.cloudPreference;
  for (const k of Object.keys(PROVIDERS)) {
    const v = update.models?.[k];
    if (v === '') delete cur.models[k];                       // empty: back to the default model
    else if (typeof v === 'string' && MODEL_RE.test(v)) cur.models[k] = v;
  }
  if (['manual', 'auto'].includes(update.mode)) cur.mode = update.mode;
  for (const k of TASK_KINDS) if (update.tasks?.[k] in PROVIDERS) cur.tasks[k] = update.tasks[k];
  const url = cleanBaseUrl(update.endpoint?.baseUrl);
  if (url) cur.endpoint.baseUrl = url;
  if (KEY_ENV_RE.test(update.endpoint?.apiKeyEnv ?? '')) cur.endpoint.apiKeyEnv = update.endpoint.apiKeyEnv;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cur, null, 2));
  return cur;
}

/** The model to use for a provider: the user's choice, else the default. */
function modelFor(id, s = load()) {
  return s.models[id] || PROVIDERS[id].defaultModel();
}

/** Where the OpenAI-compatible lane connects. The key is read from the environment, never stored. */
function endpointFor(s = load()) {
  return { baseUrl: s.endpoint.baseUrl, apiKeyEnv: s.endpoint.apiKeyEnv, apiKey: process.env[s.endpoint.apiKeyEnv] };
}

const QUICK_MAX_WORDS = 12;

/**
 * What kind of task is this message? 'agent' needs tools, 'quick' is a short plain question,
 * everything else is 'chat'. Only used in auto mode.
 */
function classifyTask(text, { wantsTools = false } = {}) {
  if (wantsTools) return 'agent';
  const t = String(text ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= QUICK_MAX_WORDS && !t.includes('```') && !t.includes('\n') ? 'quick' : 'chat';
}

/** Enabled AND configured, per provider. */
function available(s = load()) {
  return Object.fromEntries(Object.keys(PROVIDERS).map(k => [k, s.providers[k] && PROVIDERS[k].configured(s)]));
}

/** Everything the Settings panel shows. */
function status() {
  const s = load();
  const avail = available(s);
  return {
    cloudPreference: s.cloudPreference,
    mode: s.mode,
    tasks: s.tasks,
    endpoint: { baseUrl: s.endpoint.baseUrl, apiKeyEnv: s.endpoint.apiKeyEnv },
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, model: modelFor(id, s), enabled: s.providers[id], configured: p.configured(s),
      available: avail[id], needs: p.needs(s),
    })),
  };
}

const ENGINE_OF = { local: 'gemma', claude: 'claude', nvidia: 'kimi' };
const PROVIDER_OF = { gemma: 'local', claude: 'claude', kimi: 'nvidia' };

/**
 * Choose the engine for a routed request.
 * @param {{target:'local'|'cloud'|'kimi', private:boolean}} plan  the brain's decision
 * @param {object} ctx
 *   available        {local, claude, nvidia} booleans
 *   cloudPreference  'claude' | 'nvidia'
 *   forced           null | 'gemma' | 'claude' | 'kimi'   (user typed /local, /cloud…)
 *   wantsTools       the chat asked for an action that needs tools (only Claude has them)
 * @returns {{engine:'gemma'|'claude'|'kimi', note?:string} | {blocked:string}}
 */
function pickByRules(plan, { available: av, cloudPreference = 'claude', forced = null, wantsTools = false }) {
  if (forced) {
    const provider = PROVIDER_OF[forced];
    if (av[provider]) return { engine: forced };
    return { blocked: `${PROVIDERS[provider].label} is turned off or not configured. Turn it on in ⚙ Settings, or type /auto.` };
  }

  const clouds = wantsTools
    ? ['claude', 'nvidia']
    : cloudPreference === 'nvidia' ? ['nvidia', 'claude'] : ['claude', 'nvidia'];
  const firstCloud = () => clouds.find(c => av[c]);

  if (plan.target === 'local') {
    if (av.local) return { engine: 'gemma' };
    // Private conversations stay on this computer: never send them to the cloud because Ollama is paused.
    if (plan.private) {
      return { blocked: 'This conversation is private, so it only runs on your computer — but Ollama is paused. ' +
        'Turn Ollama on in ⚙ Settings, or clear the conversation to ask something else.' };
    }
    const cloud = firstCloud();
    if (cloud) return { engine: ENGINE_OF[cloud], note: 'Ollama paused' };
    return { blocked: 'Every model is turned off. Turn one on in ⚙ Settings.' };
  }

  const preferred = plan.target === 'kimi' ? ['nvidia', 'claude'] : clouds;
  const cloud = preferred.find(c => av[c]);
  if (cloud) {
    const note = wantsTools && cloud !== 'claude' ? 'Claude is off: answering without tools' : undefined;
    return note ? { engine: ENGINE_OF[cloud], note } : { engine: ENGINE_OF[cloud] };
  }
  if (av.local) return { engine: 'gemma', note: 'cloud models off: answered locally' };
  return { blocked: 'Every model is turned off. Turn one on in ⚙ Settings.' };
}

/**
 * pickByRules plus auto mode: with mode 'auto' the task table (tasks[taskKind]) chooses the
 * provider. A forced engine and a private conversation skip it; privacy rules always win.
 * ctx adds: mode 'manual'|'auto', tasks {chat,agent,quick}, taskKind 'chat'|'agent'|'quick'.
 */
function pickProvider(plan, ctx) {
  const { available: av, forced = null, wantsTools = false, mode = 'manual', tasks = DEFAULTS.tasks, taskKind = 'chat' } = ctx;
  if (mode !== 'auto' || forced || plan.private) return pickByRules(plan, ctx);
  const wanted = tasks[taskKind];
  if (av[wanted]) {
    const note = wantsTools && wanted !== 'claude' ? `${PROVIDERS[wanted].label} has no tools: answering without them` : undefined;
    return note ? { engine: ENGINE_OF[wanted], note } : { engine: ENGINE_OF[wanted] };
  }
  const r = pickByRules(plan, ctx);
  const why = `${PROVIDERS[wanted].label} unavailable`;
  return r.blocked ? r : { ...r, note: [why, r.note].filter(Boolean).join(' · ') };
}

module.exports = { PROVIDERS, load, save, available, status, pickProvider, modelFor, endpointFor, classifyTask };
