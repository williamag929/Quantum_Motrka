# Per-Task Provider and Model Selection

Written for: developers working on the Motkra daemon, brain and VS Code extension.

Status: approved design, not yet implemented. Implementation plan comes next.

## Problem

Each model provider is wired to a fixed model in code or `.env`:

- `motkra-daemon/settings.js` lets the user turn providers on or off, but the model is hard-coded (`claude-opus-4-7`, `moonshotai/kimi-k2.6`).
- `dual_ai/config.py` and `dual_ai_ext/clients/kimi.js` each read `KIMI_MODEL` on their own.
- The extension keeps a second copy of the settings logic in `core/provider-settings.js`.

When NVIDIA retired `moonshotai/kimi-k3` (HTTP 410), there was no way to change the model from the UI. The same gap blocks choosing a model per kind of task, the way Cline does.

## Goals

- The user picks provider and model per task kind: `chat`, `agent` (needs tools) and `quick` (short answers).
- Motkra can also choose automatically, based on the task. Manual choices always win.
- Any OpenAI-compatible endpoint can be added without code changes.
- One source of configuration, owned by the daemon. The tray and the extension are clients.
- The privacy rules do not change: private turns never reach a cloud provider, and cloud payloads are always redacted.

## Non-goals

- Replacing the Anthropic or Ollama clients. They keep their own code.
- Adopting the Cline SDK. That depends on the audit in Phase 21A.
- A secrets vault. Until Phase 23 exists, keys are read from environment variables.
- Automatic model discovery beyond a single `GET /models` call per provider.

## Approaches considered

1. **Settings-driven resolver in the daemon (chosen).** One resolver maps a task kind to a provider and model. Clients only read and write settings.
2. **Hard-coded models in each client (current).** Changing a model means editing code. This caused the Kimi outage.
3. **Adopt the Cline SDK now.** Covers the same ground, but the privacy audit in 21A is not done, and this would couple the change to it.

## Design

### Data model

`~/.motkra/settings.json` (existing file, extended):

```json
{
  "providers": [
    { "id": "ollama", "kind": "ollama", "label": "Ollama (local)", "baseUrl": "http://localhost:11434", "enabled": true },
    { "id": "claude", "kind": "anthropic", "label": "Claude", "enabled": true, "apiKeyEnv": "ANTHROPIC_API_KEY" },
    { "id": "nvidia", "kind": "nvidia", "label": "NVIDIA", "baseUrl": "https://integrate.api.nvidia.com/v1", "enabled": true, "apiKeyEnv": "NVIDIA_API_KEY" },
    { "id": "custom", "kind": "openai-compatible", "label": "Custom", "baseUrl": "", "enabled": false, "apiKeyEnv": "" }
  ],
  "tasks": {
    "chat":  { "provider": "claude", "model": "claude-opus-4-7" },
    "agent": { "provider": "claude", "model": "claude-opus-4-7" },
    "quick": { "provider": "ollama", "model": "gemma4:e2b" }
  },
  "mode": "manual"
}
```

- `mode` is `manual` or `auto`. In `auto`, the rules below choose the task kind.
- Keys are never stored in this file. `apiKeyEnv` names the environment variable to read. When Phase 23 lands, this field is replaced by a store reference.
- The existing `providers` (boolean map) and `cloudPreference` fields are migrated on first load. Old values map to the new `enabled` flags.

### Components

1. **`motkra-daemon/providers.js` (new).** Owns the provider list and the task table. Replaces the fixed `PROVIDERS` map in `settings.js`. Exposes:
   - `GET /settings/providers`: current config. Never includes key values, only `configured: true|false`.
   - `PUT /settings/providers`: validated update.
   - `GET /models?provider=<id>`: model list from the provider's `/models` endpoint, when it has one.
   - `POST /providers/<id>/test`: sends a one-token request with the chosen model and returns the status and message, for example "404 model not found".
2. **OpenAI-compatible client.** One streaming client for `kind: nvidia` and `kind: openai-compatible`. The existing `fold_system` workaround for NVIDIA stays in this client. The Kimi-specific temperature defaults become per-provider settings.
3. **Brain (`dual_ai`).** `plan()` now returns the task kind as well as the privacy decision. A resolver reads `tasks` and picks the provider and model. `config.py` stops holding model IDs; it keeps only defaults for first run.
4. **Tray settings (`motkra-daemon` UI).** Each task has a provider dropdown and a model dropdown, with a Test button. Providers can be enabled, disabled, and added (`openai-compatible`).
5. **Extension (`dual_ai_ext`).** A selector in the panel shows the task and the model in use. It reads state from the daemon. If the daemon is down, it reads the settings file as a fallback. `core/provider-settings.js` becomes a thin client of this state, which also covers part of Phase 21E-3.

### Auto mode rules

Applied only when `mode` is `auto`. The first matching rule wins:

1. The request needs tools (`needsTools`) → `agent`. Only providers that support tool calls qualify; if none is enabled, fall back to manual `agent`.
2. The request is short (below a configurable threshold) and has no code block → `quick`.
3. Otherwise → `chat`.

The privacy filter runs before these rules. A private turn only ever resolves to the local provider.

### Data flow

1. The user sends a message. The brain redacts secrets and decides privacy.
2. The resolver takes the task kind from the rules (auto) or from the request (manual) and looks up `tasks`.
3. If the chosen provider is disabled or unavailable, the resolver tries the next enabled provider that the privacy decision allows. The fallback is recorded in the response so the UI shows it.
4. The engine streams the reply. Placeholders are restored as before.

### Error handling

- A model that returns 404 or 410 is reported with the provider's message. Example: "NVIDIA: model moonshotai/kimi-k3 has reached end of life". The run is not retried against the same model.
- A missing environment variable is reported as "not configured", with the variable name.
- A private turn with no local provider available is blocked with a message. It is never sent to a cloud provider.
- Fallback never happens silently. Every fallback appears in the chat.

### Testing

- `dual_ai`: unit tests for the resolver, the auto rules, and the fallback. An invariant test: a private turn never resolves to a cloud provider, for every mode and task.
- `motkra-daemon`: API tests for `/settings/providers` and `/models`. A test that the response never contains a key value.
- `dual_ai_ext`: tests for the state client and for the fallback to the settings file.
- A live smoke test: `POST /providers/<id>/test` against each enabled provider.

### Phasing

- **M1:** data model with migration, `providers.js`, OpenAI-compatible client, tray settings UI.
- **M2:** extension selector and `auto` rules.
- **M3:** `/models` listing, fallback, and the Test button.

## Open items

- The default `quick` threshold is a placeholder. It should be measured with `bench/` before it is fixed.
- Whether the `quick` task can use a cloud provider when Ollama is paused has to follow the existing privacy rules. The spec does not change them.
- The `kimi-k2.6` default that is currently uncommitted in `motkra-daemon/settings.js` and `dual_ai/config.py` will be replaced by the task table in M1. Until then, it does not work for accounts without access to that model.
