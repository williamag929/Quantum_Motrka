# motkra-mcp

Motkra's MCP server — exposes local Ollama models **and GitHub** to Claude Code,
Claude Desktop, Cursor, and any MCP-compatible client. Plain Node, no
dependencies. Transports: **stdio** (always) and **TCP** (set `MOTKRA_MCP_PORT`).

## Tools

| Tool | What it does |
|------|--------------|
| `motkra_digest` | local model reads files from disk, returns a short redacted answer |
| `motkra_result` | collect a background `motkra_digest` job |
| `ollama_chat` | chat with any local Ollama model |
| `ollama_list_models` | list local Ollama models |
| `github_list_issues` | list issues (or PRs with `pull:true`) in a repo |
| `github_get_issue` | read one issue/PR with body + comments |
| `github_create_issue` | create an issue |
| `github_comment` | comment on an issue/PR |
| `github_pr_diff` | a PR's state, branches, +additions, how to fetch its diff |
| `github_pr_files` | the files a PR changed, with diff patches |
| `motkra_task` | delegate a whole coding task to the autonomous Motkra agent loop |

## GitHub token

The GitHub tools work unauthenticated on **public** repos (low rate limit, 60/hr).
For private repos, creating issues/comments, and a higher limit, set a token:

```bash
# a fine-grained token with Contents:read + Issues:read/write on your repo
export GITHUB_TOKEN=ghp_...
```

In this repo, `.mcp.json` already forwards `${GITHUB_TOKEN}` to the server, so a
Claude Code session here has GitHub once the env var is set.

## motkra_task — let Claude delegate real work

`motkra_task` runs the full Motkra agent loop (read/edit files, run commands,
run tests, self-correct) on a goal Claude hands it, and reports every action as
text. Claude stays the supervisor; Motkra does the legwork.

It needs the **Anthropic API key** in the server's environment (it runs Claude
under the hood):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Two safety knobs:
- **Writes are auto-applied** (no UI to confirm in MCP mode). Set
  `MOTKRA_TASK_REQUIRE_APPROVAL=1` for a **dry-run** that refuses writes and only
  reports the planned changes.
- Tools are confined to `root` (defaults to the server's cwd); `run_command` uses
  the same allowlist approach as the extension.

Reach for it on longer autonomous tasks; for quick edits Claude should just do
them itself.

## Run

```bash
npm test          # node --test
npm start         # stdio MCP server
```
