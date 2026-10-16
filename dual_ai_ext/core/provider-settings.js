'use strict';

// Model providers the user turned on or off in the Motkra desktop app (⚙ Settings).
// Same file and rules as motkra-daemon/settings.js, kept separate because this extension
// ships on its own: ~/.motkra/settings.json → { providers: {local, claude, nvidia}, cloudPreference }.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const LABEL = { local: 'Ollama (local)', cloud: 'Claude (Anthropic)', kimi: 'NVIDIA (Kimi)' };

function settingsFile() {
  return path.join(process.env.MOTKRA_DIR ?? path.join(os.homedir(), '.motkra'), 'settings.json');
}

const MODEL_RE   = /^[\w.\-:\/]{1,200}$/;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1';
const MODEL_OF   = { claude: 'cloud', nvidia: 'kimi', local: 'local' };   // desktop app name → extension name

function readSaved() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

/** https anywhere, plain http only for this computer; else null. */
function cleanBaseUrl(value) {
  try {
    const u = new URL(String(value));
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return String(value).trim().replace(/\/+$/, '');
  } catch {}
  return null;
}

/** The OpenAI-compatible lane (Kimi): model, endpoint and key, as chosen in the desktop app. */
function kimiConfig() {
  const saved = readSaved();
  const model = MODEL_RE.test(saved.models?.nvidia ?? '') ? saved.models.nvidia : (process.env.KIMI_MODEL || 'moonshotai/kimi-k2.6');
  const apiKeyEnv = KEY_ENV_RE.test(saved.endpoint?.apiKeyEnv ?? '') ? saved.endpoint.apiKeyEnv : 'NVIDIA_API_KEY';
  return { model, baseUrl: cleanBaseUrl(saved.endpoint?.baseUrl) ?? NVIDIA_URL, apiKeyEnv, apiKey: process.env[apiKeyEnv] };
}

const QUICK_MAX_WORDS = 12;

/** Same rule as the desktop app's classifyTask (without 'agent': this panel's cloud models always have tools). */
function classifyTask(text) {
  const t = String(text ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= QUICK_MAX_WORDS && !t.includes('```') && !t.includes('\n') ? 'quick' : 'chat';
}

function load() {
  const saved = readSaved();
  const on = k => (typeof saved.providers?.[k] === 'boolean' ? saved.providers[k] : true);
  return {
    available: {
      local: on('local'),
      cloud: on('claude') && !!process.env.ANTHROPIC_API_KEY,
      kimi:  on('nvidia') && !!kimiConfig().apiKey,
    },
    cloudPreference: saved.cloudPreference === 'nvidia' ? 'kimi' : 'cloud',
    mode: saved.mode === 'auto' ? 'auto' : 'manual',
    tasks: {
      chat:  MODEL_OF[saved.tasks?.chat]  ?? 'cloud',
      agent: MODEL_OF[saved.tasks?.agent] ?? 'cloud',
      quick: MODEL_OF[saved.tasks?.quick] ?? 'local',
    },
  };
}

/**
 * @param {'local'|'cloud'} routed   what the router chose
 * @param {object} ctx
 *   available        {local, cloud, kimi}
 *   cloudPreference  'cloud' | 'kimi'
 *   forced           null | 'local' | 'cloud' | 'kimi'   (the panel's model switch)
 *   secretLocal      a secret was detected, so the message may only go to the local model
 * @returns {{model:'local'|'cloud'|'kimi', note?:string} | {blocked:string}}
 */
function pick(routed, ctx) {
  const { available: av, forced = null, secretLocal = false, mode = 'manual', tasks, taskKind = 'chat' } = ctx;
  // Auto mode: the task table chooses. A secret or a forced switch skip it, so privacy always wins.
  if (mode !== 'auto' || secretLocal || forced || !tasks) return pickByRouter(routed, ctx);
  const wanted = tasks[taskKind];
  if (av[wanted]) return { model: wanted };
  const r = pickByRouter(routed, ctx);
  return r.blocked ? r : { ...r, note: [`${LABEL[wanted]} unavailable`, r.note].filter(Boolean).join(' · ') };
}

function pickByRouter(routed, { available: av, cloudPreference = 'cloud', forced = null, secretLocal = false }) {
  if (secretLocal) {
    return av.local ? { model: 'local' }
      : { blocked: 'This message contains a secret, so it only goes to the local model — but Ollama is paused. ' +
          'Turn Ollama on in the Motkra app (⚙ Settings) or remove the secret.' };
  }
  if (forced) {
    return av[forced] ? { model: forced }
      : { blocked: `${LABEL[forced]} is turned off or not configured. Turn it on in the Motkra app (⚙ Settings) or switch to Auto.` };
  }
  const clouds = cloudPreference === 'kimi' ? ['kimi', 'cloud'] : ['cloud', 'kimi'];
  if (routed === 'local') {
    if (av.local) return { model: 'local' };
    const cloud = clouds.find(c => av[c]);
    return cloud ? { model: cloud, note: 'Ollama paused' } : { blocked: 'Every model is turned off in the Motkra app (⚙ Settings).' };
  }
  const cloud = clouds.find(c => av[c]);
  if (cloud) return { model: cloud };
  return av.local ? { model: 'local', note: 'cloud models off' } : { blocked: 'Every model is turned off in the Motkra app (⚙ Settings).' };
}

module.exports = { load, pick, settingsFile, kimiConfig, classifyTask };
