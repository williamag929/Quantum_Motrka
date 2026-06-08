'use strict';

const vscode = require('vscode');

const SPEECH_EXT = 'ms-vscode.vscode-speech';

async function _activate() {
  const ext = vscode.extensions.getExtension(SPEECH_EXT);
  if (!ext) return null;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { return null; }
  }
  return ext.exports ?? null;
}

/**
 * Start a speech-to-text session.
 * Calls onPartial(text) for interim results, onFinal(text) when a phrase is recognized.
 * Returns a dispose function to stop recording, or null if the extension is unavailable.
 *
 * @param {(text: string) => void} onPartial
 * @param {(text: string) => void} onFinal
 * @returns {Promise<(() => void) | null>}
 */
async function startSTT(onPartial, onFinal) {
  const api = await _activate();

  if (!api?.createSpeechToTextSession) {
    const choice = await vscode.window.showWarningMessage(
      'Motkra voice input requires the "VS Code Speech" extension.',
      'Install'
    );
    if (choice === 'Install') {
      vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        SPEECH_EXT
      );
    }
    return null;
  }

  const { SpeechToTextStatus } = api;
  const session  = await api.createSpeechToTextSession();
  const listener = session.onDidChange(e => {
    if (e.status === SpeechToTextStatus.Recognizing && e.text) onPartial(e.text);
    else if (e.status === SpeechToTextStatus.Recognized && e.text) onFinal(e.text);
  });

  return () => { listener.dispose(); session.dispose(); };
}

/**
 * Speak prose text aloud. Strips fenced code, inline code, and markdown symbols.
 * Silently skips if the Speech extension is unavailable, TTS API is missing,
 * or the text exceeds 200 words.
 *
 * @param {string} text
 */
async function speak(text) {
  const api = await _activate();
  if (!api?.createTextToSpeechSession) return;

  const prose = text
    .replace(/```[\s\S]*?```/g, '')   // strip fenced code
    .replace(/`[^`\n]+`/g, '')        // strip inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#+\s/g, '')
    .trim();

  if (!prose) return;
  if (prose.split(/\s+/).filter(Boolean).length > 200) return;

  try {
    const session = await api.createTextToSpeechSession();
    await session.synthesize(prose);
    session.dispose();
  } catch { /* non-critical */ }
}

module.exports = { startSTT, speak };
