# 126 — coworker: Anthropic /v1/messages wire for openmodel provider

GitHub Issue: #398

## Prerequisite

- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148) — delegation
  policy; the provider-input fence and profile contract that this issue's new wire path
  must satisfy without change.

**Prior-art verdict:** No shipped or queued orchestrator-pack issue touches coworker
provider routing, Anthropic wire, or openmodel. The `openmodel` entry already exists in
`~/.config/coworker/providers.yaml` with an explicit comment: *"Not usable as coworker
default until coworker gains anthropic client support; kept for reference / future use."*
This issue builds exactly that missing support. Scope is net-new.

**Design analysis (pre-draft):**

*Critical mechanics.* `coworker` has a single HTTP client path: `from openai import
OpenAI` in `providers.py:make_client()`. `cli.py:build_messages()` returns an
OpenAI-format list `[{role:system,...},{role:user,...}]`, and the call site invokes
`client.chat.completions.create(messages=..., ...)` extracting
`response.choices[0].message.content`. The Anthropic SDK differs on three surfaces:
(1) system prompt is a top-level param, not a role:system entry in messages; (2) the
call is `client.messages.create(system=..., messages=[user-turns], ...)`; (3) response
extraction is `response.content[0].text`. The delta is additive and localised to two
functions.

*Industry practice.* Multi-wire provider registries in LLM tooling (LiteLLM, aisuite,
instructor) carry an explicit `wire` or `api_type` field per provider entry and branch
client construction + call shape on it. The pattern is stable and low-maintenance.

*Options:*

| Option | Cost | Risk | Sufficiency |
|---|---|---|---|
| **A. Add Anthropic wire branch to coworker fork** (chosen) | ~60 lines in 2 files + 1 dep | Low — additive, existing paths unchanged | Enables openmodel directly |
| B. Local OpenAI-compat proxy for openmodel | High — separate process, deployment | Medium — new moving part | Same result, over-engineered |
| C. Keep opencode (no change) | Zero | Zero | Current state — `deepseek-v4-flash-free` via relay, no prefix cache |

Option C's gap: opencode uses `deepseek-v4-flash-free` (relay, `prefix_cache:false`),
while openmodel serves `deepseek-v4-flash` with `prefix_cache:true` — repeated corpus
reads get cached. Option A is cheapest sufficient.

## Goal

Add an Anthropic `/v1/messages` wire branch to the `chetwerikoff/coworker` fork so
the `openmodel` provider can serve `deepseek-v4-flash` with prefix caching, replacing
the current `opencode` relay. Workers (Cursor, Codex) and the architect seat call the
same `coworker ask --profile code` interface — the only observable difference is the
stats line changes from `model=deepseek-v4-flash-free` to `model=deepseek-v4-flash`.
Prefix caching is a server-side benefit (`prefix_cache: true` in provider config); cache
hit observability is not a blocking AC for this issue.

```behavior-kind
action-producing
```

## Binding surface

After this issue merges into the coworker fork:

- `providers.yaml` provider configs accept an optional `wire` field. Absence defaults to
  `openai` (backward compat). Value `anthropic` selects the Anthropic client.
- When `wire == "anthropic"`, the provider routes calls to the Anthropic Messages API:
  system prompt is passed as a top-level parameter (not a `role:system` message entry),
  the response text is extracted from the Anthropic response format, and auth is read from
  the provider's `env_key`. Missing key exits non-zero with a clear error.
- All existing provider call paths (OpenAI wire) are unchanged by this addition.
- `openmodel` entry in `~/.config/coworker/providers.yaml` gains `wire: anthropic` and
  loses the "Not usable" comment.
- `COWORKER_DEFAULT_PROVIDER` in `~/.config/deepseek/coworker.env` switches from
  `opencode` to `openmodel`.

**Operator adoption (post fork-PR merge):**
1. Re-install from fork with `anthropic` dep: `pip install --upgrade "git+https://github.com/chetwerikoff/coworker.git"` in the deepseek venv (or `pip install -e .` from local clone). Verify `python -c "import anthropic"` exits 0.
2. Confirm `OPENMODEL_API_KEY` is present in `~/.config/deepseek/secrets.env`.
3. Apply `providers.yaml` edit: add `wire: anthropic` to the `openmodel` block; remove the "Not usable" comment.
4. Apply `coworker.env` edit: `COWORKER_DEFAULT_PROVIDER=openmodel`.
5. Apply `profiles.yaml` edit: change `recommended_provider` from `opencode` to `openmodel` in both `code` and `write` profiles.
6. Smoke test: `coworker ask --profile code --paths docs/issue_queue_index.md --question "list 3 issue numbers"` — stats line must show `model=deepseek-v4-flash`.

## Files in scope

Work is in the **`chetwerikoff/coworker` fork**. Worker clones the fork into `./coworker/`
within the AO worktree, makes changes, opens PR against `chetwerikoff/coworker`. All fork
paths (including root-level `pyproject.toml`) land under `coworker/` in the worktree and
are covered by the `allowed-roots` fence below.

Source files in `./coworker/` (planner chooses names and abstraction boundaries):
- Anthropic wire routing (provider resolution, client construction, call/response)
- `ask` and `write` subcommand Anthropic wire path
- Package dependency: `anthropic>=0.30` as a required runtime dependency (not optional extras)

Local config (operator applies post-PR — not tracked in orchestrator-pack):
- `~/.config/coworker/providers.yaml` — `openmodel` block: add `wire: anthropic`, remove comment
- `~/.config/deepseek/coworker.env` — `COWORKER_DEFAULT_PROVIDER=openmodel`

## Files out of scope

- `orchestrator-pack/prompts/agent_rules.md` — delegation policy is wire-transparent; no change needed
- `orchestrator-pack/plugins/**`, `orchestrator-pack/scripts/**`
- `~/.config/coworker/profiles.yaml` — local config, operator-only post-merge action (see Operator adoption step 5); not in worker scope

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
orchestrator-pack/plugins/**
orchestrator-pack/scripts/**
```

Scope boundary note: This denylist is scoped to `126-coworker-anthropic-wire-openmodel-provider`.

```allowed-roots
coworker/
```

## Acceptance criteria

1. `coworker ask --profile code --provider openmodel --paths docs/issue_queue_index.md --question "list 3 issue numbers"` exits 0 with non-empty text output.

```positive-outcome
asserts: coworker ask --provider openmodel exits 0 and stats line shows model=deepseek-v4-flash
input: realistic
```

2. Stats line shows `model=deepseek-v4-flash` (not `deepseek-v4-flash-free`).
3. `coworker ask --profile code --provider opencode --paths docs/issue_queue_index.md --question "test"` exits 0 — OpenAI wire path not regressed.
4. Provider config without `wire:` field (e.g. `deepseek`, `moonshot`) resolves to OpenAI wire with no error.
5. `OPENMODEL_API_KEY=""` causes exit non-zero with message `[coworker] env var 'OPENMODEL_API_KEY' not set` — not a Python traceback.
6. `coworker ask --profile code --provider openmodel --allow-code --paths <source-file> --question "..."` works (code corpus via Anthropic wire).
8. `coworker write --profile write --provider openmodel --spec "write one sentence about the purpose of coworker" --target /tmp/test-out.md` exits 0 and `/tmp/test-out.md` is non-empty.
9. (Post-adoption, profile isolation): after operator applies all adoption steps, `COWORKER_DEFAULT_PROVIDER="" coworker ask --profile code --paths docs/issue_queue_index.md --question "test"` (env var unset, no `--provider`) stats line shows `model=deepseek-v4-flash` — proves `profiles.yaml` `recommended_provider=openmodel` is authoritative independently of the env fallback.

## Upgrade-safety check

- No edits to orchestrator-pack core, vendor, or `packages/core/**`.
- All changes are additive to the coworker provider resolution chain; existing provider entries (`opencode`, `deepseek`, `moonshot`) are unaffected by the new `wire` field (absent = OpenAI default).
- Local config changes are manual operator steps; no CI pipeline is modified.
- If the fork PR is not yet merged, `COWORKER_DEFAULT_PROVIDER` stays `opencode` — no degradation.

## Verification

In the coworker fork clone:

```bash
# Install (anthropic is a required runtime dep, no extras flag needed)
pip install -e .

# AC#1: openmodel wire works
coworker ask --profile code --provider openmodel \
  --paths ~/.config/coworker/providers.yaml \
  --question "what wire type does the openmodel provider use?"
# Expected: exits 0, non-empty answer, stats line: [coworker: model=deepseek-v4-flash ...]

# AC#3: opencode regression check
coworker ask --profile code --provider opencode \
  --paths ~/.config/coworker/providers.yaml \
  --question "what is the opencode base_url?"
# Expected: exits 0, stats line: model=deepseek-v4-flash-free

# AC#4: no-wire provider defaults to OpenAI wire (opencode is auth_optional, no key needed)
coworker ask --profile code --provider opencode \
  --paths ~/.config/coworker/providers.yaml \
  --question "what is the opencode base_url?"
# Expected: exits 0 with non-empty response; stats line shows model=deepseek-v4-flash-free
# (proves opencode path untouched; its auth_optional means no credential needed)

# AC#5: missing key error
OPENMODEL_API_KEY="" coworker ask --profile code --provider openmodel \
  --paths /dev/null --question "test"
# Expected: exits non-zero, prints: [coworker] env var 'OPENMODEL_API_KEY' not set
```

## contract-evidence

This draft creates new code in the `chetwerikoff/coworker` fork (external repo — not
in the orchestrator-pack repoOwned registry). The openmodel wire contract is verified
in that repository's implementation/tests, not by an orchestrator-pack capture producer.

```contract-evidence
none
```
