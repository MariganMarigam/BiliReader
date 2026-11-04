# AGENTS.md

## Fork-specific

- No release bundling during iteration — use `scripts/bilireader-run.sh` (hot reload).
- Check `df -h /` before a build: ≥ 8 GB free, else `scripts/bilireader-clean.sh --yes`.
- Artifacts go to `dist/` (git-excluded via `.git/info/exclude`), never into git.
- Linux dev and builds run the CEF runtime; details in `docs/lean-workflow.md`.
