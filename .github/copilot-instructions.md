# Copilot instructions for this repository

NOTE: I couldn't find existing agent docs in the workspace; this file is an initial scaffold. Please point me to the project root or upload the repository files if you want a fully specific version.

Keep instructions concise and focused on the codebase patterns that make an AI productive quickly.

What this repo appears to be
- A Python project (workspace named `Quantum`) but there were no files in the scanned workspace snapshot. The repo likely contains domain-specific modules; update paths below when files are available.

Key goals for AI agents
- Preserve existing code style and imports (PEP8 with 4 spaces is assumed)
- Avoid introducing new heavy dependencies without user approval
- Prefer small, testable edits and add unit tests when adding logic

Quick tasks an AI can safely perform
- Fix obvious syntax/typing errors and broken imports
- Add small unit tests using pytest if `tests/` exists
- Improve docstrings and small refactors that keep public APIs unchanged

Patterns to look for (fill when files available)
- Entry points: look for `if __name__ == "__main__"`, `setup.py`/`pyproject.toml`, or a `src/` package
- Config: check for `config.py`, `.env`, or `settings/` module
- Data flows: find places where objects are loaded from disk, transformed, and saved (e.g., `load_*`, `save_*` functions)

Project-specific conventions to document
- Tests: preferred test runner (pytest/unittest) and test discovery rules
- Formatting: black/flake8/isort usage
- Type hints: whether mypy is enforced

How to suggest changes
- Create a short PR with a single focused change
- Include a brief rationale and tests/linters changes if applicable

Examples (replace with repo-specific files when available)
- If you see a module `quantum/simulator.py`, use `Simulator.run()` rather than adding new top-level scripts
- Prefer adding helpers under `quantum/utils.py` for small shared utilities

Files to check first (update this list when repo scanned)
- `pyproject.toml`, `setup.cfg`, `requirements.txt` - for dependencies and toolchain
- `README.md` - for high-level architecture and run commands
- `src/` or package folder - primary code
- `tests/` - existing tests and patterns

If this file is not specific enough
- Give the path to the repository root, or upload the codebase snapshot. I will re-scan and produce a targeted 20-40 line instruction file with concrete examples and commands.

Please tell me where the code is or confirm I should rescan the workspace; I'll then refine this file.
