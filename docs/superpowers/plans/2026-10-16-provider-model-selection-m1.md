# Provider and Model Selection, M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user picks the model for each provider and the endpoint for the OpenAI-compatible lane in ⚙ Settings, and can test a model before using it.

**Architecture:** `motkra-daemon/settings.js` keeps its schema and gains `models` (model id per provider) and `endpoint` (`baseUrl`, `apiKeyEnv` for the OpenAI-compatible lane, which is NVIDIA by default). `kimi.js` and `ipc.js` read the model from settings instead of fixed values. A `provider-test` IPC sends a one-token request and reports the provider's answer.

**Tech Stack:** Node (node:test), Electron IPC, plain HTML in `chat.html`.

**Spec:** `docs/superpowers/specs/2026-10-16-provider-model-selection-design.md`

**Deviation from the spec:** M1 extends the existing flat schema instead of introducing the `providers` array and the `tasks` table. The `tasks` table, `auto` mode and a separate `custom` provider move to M2. The OpenAI-compatible lane stays the engine `kimi`, and its label comes from the endpoint.

## Global Constraints

- Settings live in `~/.motkra/settings.json` (`MOTKRA_DIR` overrides the folder). API keys are never written to it; only the variable name is (`apiKeyEnv`).
- Private conversations never reach a cloud provider. `pickProvider` is not changed.
- Existing `settings.test.js` tests keep passing without edits.
- `baseUrl` must be `https:`, or `http:` only for `localhost` / `127.0.0.1`.

## Review Focus

- A model id with spaces or shell characters is rejected on save (kept as before).
- A provider returns 404 or 410 for the model: the test shows the provider's message, nothing is saved as working.
- `apiKeyEnv` points at a variable that is not set: reported as "not configured", with the variable name.
- Settings written by the old version (no `models`, no `endpoint`) load with the defaults.
- The settings response never contains an API key value.

---

### Task 1: Model and endpoint settings

**Files:**
- Modify: `motkra-daemon/settings.js`
- Test: `motkra-daemon/test/settings.test.js`

**Interfaces:**
- Produces: `modelFor(id: 'local'|'claude'|'nvidia', s = load()) -> string`; `endpointFor(s = load()) -> {baseUrl: string, apiKey: string|undefined, apiKeyEnv: string}`; `load()` additionally returns `models` and `endpoint`; `save(update)` accepts `models` and `endpoint`; `status()` providers carry `model` (the effective one) and the status has `endpoint: {baseUrl, apiKeyEnv}`.

- [ ] **Step 1: Write failing tests** in `settings.test.js`: defaults (`modelFor('claude')==='claude-opus-4-7'`, `modelFor('nvidia')==='moonshotai/kimi-k2.6'`, base URL `https://integrate.api.nvidia.com/v1`, `apiKeyEnv==='NVIDIA_API_KEY'`); saving `models.nvidia='nvidia/nemotron-3-super-120b-a12b'` changes `modelFor` and `status()`; invalid model (`'bad model; rm'`) and invalid `baseUrl` (`'ftp://x'`, `'http://example.com'`) are ignored; `http://localhost:1234/v1` is accepted; the file never contains a key value; an old file without the new fields loads with defaults.
- [ ] **Step 2: Run** `npm test -- --test-name-pattern=settings` in `motkra-daemon`. Expected: FAIL (`modelFor` undefined).
- [ ] **Step 3: Implement** the fields above in `settings.js`; validate model ids with `/^[\w.\-:\/]{1,200}$/`, `apiKeyEnv` with `/^[A-Z][A-Z0-9_]{0,63}$/`.
- [ ] **Step 4: Run** the full suite. Expected: all pass.
- [ ] **Step 5: Commit** `feat(settings): choose the model per provider and the OpenAI-compatible endpoint`.

### Task 2: OpenAI-compatible client and model test

**Files:**
- Modify: `motkra-daemon/kimi.js`
- Test: `motkra-daemon/test/kimi.test.js` (create)

**Interfaces:**
- Consumes: `settings.modelFor('nvidia')`, `settings.endpointFor()`.
- Produces: `streamKimi(messages, system, onToken)` unchanged signature; `testModel(provider: 'local'|'claude'|'nvidia') -> Promise<{ok: boolean, status?: number, message: string}>`. Only `nvidia` is tested over the OpenAI route in M1; `claude` and `local` return `{ok:false, message:'test not available yet'}`.

- [ ] **Step 1: Write failing tests** against a local `http.createServer` on `127.0.0.1` with `MOTKRA_DIR` set to a temp folder: `streamKimi` posts to `<baseUrl>/chat/completions` with the saved model and the bearer key from the saved `apiKeyEnv`; a 410 reply makes `testModel('nvidia')` return `{ok:false, status:410, message}` containing the server's `detail`; a missing key variable returns `{ok:false, message}` naming the variable; a 200 stream returns `{ok:true}`.
- [ ] **Step 2: Run** `node --test test/kimi.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**: use `http` or `https` by protocol; build the URL as `baseUrl.replace(/\/$/,'') + '/chat/completions'`; `testModel` sends `max_tokens: 1`. Keep `foldSystem` and the temperature defaults.
- [ ] **Step 4: Run** the full suite. Expected: all pass.
- [ ] **Step 5: Commit** `feat(kimi): use the saved model and endpoint, add a model test`.

### Task 3: Use the saved model in the Claude and Ollama paths, and the test IPC

**Files:**
- Modify: `motkra-daemon/ipc.js:44` and `:133`, `motkra-daemon/main.js` (new `provider-test` handler beside `settings-get`), `motkra-daemon/preload.js`
- Test: `motkra-daemon/test/ipc.test.js`

**Interfaces:**
- Consumes: `settings.modelFor`, `kimi.testModel`.
- Produces: `window.motkra.testProvider(id) -> Promise<{ok, status?, message}>`.

- [ ] **Step 1: Write a failing test** in `ipc.test.js` that the Claude request body and the Ollama request body use the model saved in settings.
- [ ] **Step 2: Run** the ipc tests. Expected: FAIL.
- [ ] **Step 3: Implement**: replace the two fixed models with `settings.modelFor('claude')` and `settings.modelFor('local')`; `GEMMA_MODEL` stays the default for `local`. Register `ipcMain.handle('provider-test', ...)` only for the chat window's sender, as `settings-set` does.
- [ ] **Step 4: Run** the full suite. Expected: all pass.
- [ ] **Step 5: Commit** `feat(ipc): honor the saved models and add provider-test`.

### Task 4: Settings panel

**Files:**
- Modify: `motkra-daemon/chat.html` (provider rows, endpoint fields, Test button)

**Interfaces:**
- Consumes: `window.motkra.saveSettings({models, endpoint})`, `window.motkra.testProvider(id)`.

- [ ] **Step 1: Implement**: each provider row gets a text input for the model (saved on change) and a Test button that shows the result under the row (green for ok, the provider's message otherwise). The NVIDIA row also shows `baseUrl` and `apiKeyEnv` inputs. Build the DOM with `textContent`, never `innerHTML`.
- [ ] **Step 2: Verify** by running `npm start` and exercising the panel by hand, plus `npm test`. Expected: tests pass, panel saves and tests a model.
- [ ] **Step 3: Commit** `feat(chat): model and endpoint fields with a Test button in Settings`.

### Task 5: Docs and final check

**Files:**
- Modify: `CLAUDE.md` (model providers paragraph), `dual_ai_ext/README.md` model table note

- [ ] **Step 1:** Document that models and the endpoint are set in ⚙ Settings and that `KIMI_MODEL` stays the first-run default.
- [ ] **Step 2: Run** `npm test` in `motkra-daemon` and `dual_ai_ext`, and `python -m pytest` in `dual_ai`. Expected: all pass.
- [ ] **Step 3: Commit** `docs: model selection in Settings`.
