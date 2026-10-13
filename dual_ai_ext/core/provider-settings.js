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

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  const on = k => (typeof saved.providers?.[k] === 'boolean' ? saved.providers[k] : true);
  return {
    available: {
      local: on('local'),
      cloud: on('claude') && !!process.env.ANTHROPIC_API_KEY,
      kimi:  on('nvidia') && !!process.env.NVIDIA_API_KEY,
    },
    cloudPreference: saved.cloudPreference === 'nvidia' ? 'kimi' : 'cloud',
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
function pick(routed, { available: av, cloudPreference = 'cloud', forced = null, secretLocal = false }) {
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

module.exports = { load, pick, settingsFile };
