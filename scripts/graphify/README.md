# Graphify code graph (Issue #833)

Pack-owned wrapper around the third-party Python CLI [`graphify`](https://pypi.org/project/graphifyy/)
(PyPI package `graphifyy`) that builds a structural code graph for this repo -- call/import
relationships, hub files, community/domain clusters, import cycles -- using only its free, local,
deterministic tree-sitter AST extraction path. No LLM/API key is used or required for build,
refresh, or query.

This is the pack's first Python runtime dependency. It is entirely opt-in: nothing here is wired
into CI, a required status check, or any worker session/report status transition (see
`AGENTS.md` for the strongly-recommended, non-blocking usage guidance).

## What this does NOT do

- Never runs `graphify install` or any `graphify <platform> install` variant. Those subcommands
  write into `CLAUDE.md`, `AGENTS.md`, or `.cursor/rules/**` -- files this repo's architect owns.
  `scripts/graphify/lib/Resolve-GraphifyEnv.ps1` is the single point that shells out to the real
  `graphify` executable and hard-restricts the allowed subcommand set to `extract` and `update`;
  `scripts/graphify/check-graphify-no-installer.ps1` guards this statically.
- No doc/PDF/image/video extraction, no LLM-backed community-naming (`label`, `cluster-only
  --backend`), no multi-platform skill generation, no cross-repo/global-graph features. v1 scope
  is code-only, single-repo, and limited to the three platforms this pack operates (Cursor, Codex,
  Claude Code) for its *guidance text* -- the graph tooling itself has no platform dependency.
- No new continuously-running process. Build, refresh, and query are each a plain foreground,
  on-demand invocation.

## One-time setup (per machine)

```
pwsh scripts/graphify/bootstrap.ps1
```

Creates an isolated Python virtual environment at `.graphify/venv` (never the machine's global
Python) and installs exactly the packages pinned in `requirements.lock.txt` via
`pip install --no-deps`, so nothing outside that pinned, fully-resolved set (`graphifyy` and all
29 of its transitive dependencies) can be silently substituted. List what's installed any time
with:

```
.graphify/venv/bin/python -m pip freeze
```

Regenerate `requirements.lock.txt` (only when deliberately bumping the pin) with a fresh scratch
venv: `pip install graphifyy && pip freeze > scripts/graphify/requirements.lock.txt`.

## Build / refresh / query

```
pwsh scripts/graphify/build-graph.ps1                        # first build, whole repo
pwsh scripts/graphify/build-graph.ps1 -Path scripts           # or a subset
pwsh scripts/graphify/refresh-graph.ps1                       # re-extract changed files only
pwsh scripts/graphify/query-graph.ps1 hubs --top 10
pwsh scripts/graphify/query-graph.ps1 cluster --file scripts/pr-scope-check.ts
pwsh scripts/graphify/query-graph.ps1 cycle --file docs/review-cycle-cap.mjs
```

`build-graph.ps1` wraps `graphify extract <path> --code-only --out .graphify/graph`.
`refresh-graph.ps1` wraps `graphify update .graphify/graph` (no LLM, incremental). Both write to
the untracked `.graphify/` working directory (gitignored) -- the graph is a working artifact, not
a committed source file.

`query-graph.ps1` / `query-graph.mjs` is a pure reader over the already-built `graphify-out/graph.json`
-- it never re-runs extraction or shells out to `graphify` at all. It answers the three questions
a worker needs from the graph: which files/symbols have the most edges (`hubs`), which
cluster/community a file belongs to (`cluster --file <path>`), and whether a file sits on an
import/call cycle (`cycle --file <path>`). For any other ad hoc question, the isolated venv's own
`graphify explain` / `path` / `query` / `affected` commands remain directly available (they are
pure local-graph readers too, no LLM call) -- see `graphify --help`.

## Test fixture

`__fixtures__/sample-graph.json` is a real `graphify extract --code-only` output captured from 9
real files in this repo's own `docs/*.mjs` (a genuine mutual-import cycle among the review-loop
helpers), used by `query-graph.test.ts` so the query logic is exercised against real, deterministic
data without needing network or Python at test time.
