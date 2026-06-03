# Coworker CLI delegation policy in agent rules

GitHub Issue: #148

## Prerequisite

- `docs/first_principles_5_operational_framework.md` — cost rule (“cheapest sufficient executor”);
  this issue **references** that doc, it does not duplicate the full framework in `agent_rules.md`.
- `docs/issues_drafts/51-delegation-policy-agent-rules.md` — complementary in-session subagent /
  Task delegation; ship independently or after #51 — no hard ordering unless both sections land in
  one PR and the planner chooses a single edit pass.
- `docs/issues_drafts/32-worker-acknowledge-pickup-contract.md` (GitHub #88) — `ao acknowledge`
  before any delegated bulk read or shell-out.
- Operator workstation: `coworker` on PATH and env via `~/.config/deepseek/coworker.env` (or
  equivalent) — **not** installed or wired by this pack PR; workers assume policy only.

## Goal

Reasoning-model sessions waste money when they inline-read large corpora on the expensive model, or
when they shell out to `coworker` for tiny tasks where CLI overhead dominates savings. Add a
**Coworker CLI delegation** section to universal worker rules with explicit `--profile` usage,
numeric **ask** triggers, category-bounded **write** scope, and a **do not delegate** list so every
AO worker applies the same cost-aware boundaries.

## Binding surface

- `prompts/agent_rules.md` gains a **Coworker CLI delegation** heading (worker-facing imperative
  bullets). Thresholds and profiles must be readable without opening other files; **link** to
  `docs/first_principles_5_operational_framework.md` for the broader cost ladder (no paste of
  ≥10 consecutive lines — self-architect duplicate-literal guard).
- Policy covers the external `coworker` binary only (`coworker ask`, `coworker write`; `coworker
  stats` is available for cost observability but is **optional** — this policy does not require it).
  It does not replace subagent rules from draft 51.
- **Profiles (mandatory flags):** every `coworker ask` MUST pass `--profile code` (fixed — no
  per-task override); every `coworker write` MUST pass `--profile write` unless the task issue
  names a different profile explicitly. Do not rely on operator defaults or upstream CLI defaults.
- **Upstream file gate:** default input for `coworker ask` corpus **and** `coworker write` context
  is text/markdown; source-code input requires `--allow-code` or `COWORKER_ALLOW_CODE=1` per upstream
  coworker — workers must not bypass the gate to force delegation on undeclared code unless the task
  explicitly requires code at the cheap provider.
- **Pickup before shell-out:** run `ao acknowledge` (per #88) before the first `coworker` invocation in
  the session — same ordering as other implementation work.
- Worker remains accountable for verifying coworker output, scope, commits, and AO transitions;
  `coworker` does not run `ao-declare`, `ao report`, or open PRs.
- **Reviewer carve-out (the safety net is never delegated):** the PR-review path — the canonical
  `REVIEW_COMMAND`, the `PACK_REVIEWER` selector, and the pack review wrapper it dispatches — MUST
  NOT be routed through `coworker`, and review reasoning (correctness, security, race, and logic
  findings) is never delegated to the cheap provider. The reviewer is the last safety net; nothing
  backstops its judgment, so the cost-rule’s “delegate I/O, keep reasoning” does not license cheap
  review. Rules state this prohibition explicitly so no agent “optimizes” the review path with
  coworker. (Review-path wiring itself stays out of scope — see below.)
- If `prompts/agent_rules_spawn_stub.md` is still the spawn entry, add a one-line pointer to the
  worktree rules section — planner picks minimal consistent stub wording.
- No AO core, vendor, PyPI packaging, or `agent-orchestrator.yaml` schema changes.

## Delegation contract (must appear in agent rules)

### Delegate `coworker ask` (with `--profile code`) only when at least one trigger holds

- Combined corpus for one question is **more than 600 lines** across all paths in that invocation.
- **3 or more files** under one question (same `coworker ask` call).
- Diff or log material to summarize is **more than 200 lines**.
- Bootstrap read of **2 or more config/doc paths** that together total **more than 600 lines** (or
  each path is **more than 200 lines**) where bulk read is the work, not synthesis.

**Provider-input fence (no exfiltration):** the **file material** sent to the external provider —
`coworker ask` corpus and `coworker write` context — MUST be **repo-originating and non-secret**:
this repo’s tracked files, or repo-derived material (e.g. `git diff` / `git log` / working-tree
output captured to a scratch path). Never send out-of-tree paths, external content, gitignored or
secret-bearing files, or credentials. The required `--question` / `--spec` prompt is worker-authored
task text: it MUST carry no secrets/credentials, but need not be a repo file.

**Reconciliation with draft 51 (one boundary, two cases):** draft 51’s declared-scope bound governs
delegated helpers that **edit or act** (subagent/Task launches accountable for merged edits).
`coworker ask` performs **no edit** — it only reads — so its corpus is governed by the file-material
fence above; for *reads* that fence may span repo context outside the worker’s editable declaration
without violating draft 51 (no out-of-scope edit occurs). `coworker write --target` **is** an edit and
stays inside the active declared scope per both drafts. So: writes/edits → declared scope; reads →
repo + secret fence.

### Delegate `coworker write` (with `--profile write`) only for primary drafts

- README, install docs, configuration reference (first cut).
- Standard boilerplate: LICENSE, `.gitignore`, CI workflow yaml skeletons.
- **Declared scope only:** every `--target` path MUST be inside the worker’s active declared scope.
- **Provider input fenced:** any context/input fed to `coworker write` obeys the **Corpus boundary**
  above (repo-originating, non-secret) — never feed out-of-tree, external, gitignored, or
  secret-bearing content as write context.
- **Non-destructive:** delegate only when the target does **not** exist yet, or the task issue
  explicitly authorizes replacing that file. Upstream `coworker write` truncate-writes by default —
  do not use it to overwrite an existing README, LICENSE, `.gitignore`, or workflow file unless
  replacement is in scope. Prefer `--stdout` and let the worker apply the diff when the target already
  exists.

### Do not delegate (keep on the reasoning model)

- Tasks estimated **under 2000 tokens** of real work (overhead eats savings).
- Debugging, root-cause analysis, races, safety-critical logic.
- Architectural decisions and trade-off reasoning.
- Edits requiring **exact line numbers** or surgical diffs in existing code.
- Inferring user intent or clarifying ambiguous requirements.
- **Review reasoning** — producing or shaping PR-review findings (correctness, security, race,
  logic); the review path (`REVIEW_COMMAND` / `PACK_REVIEWER`) is never routed through `coworker`.

### Ordering

- When **no** ask trigger is met, use deterministic repo tools (search, read, diff, tests) **instead
  of** `coworker ask` — do not delegate.

## Files in scope

- `prompts/agent_rules.md`
- `prompts/agent_rules_spawn_stub.md` (only if still referenced for spawn)

## Files out of scope

- `vendor/**`, `packages/core/**`
- `agent-orchestrator.yaml`, `agent-orchestrator.yaml.example`
- Installing or pinning `coworker-cli` in the repo
- Model-routing plugins, provider API wiring, CI for external models
- `docs/first_principles_5_operational_framework.md` (reference only)
- `.claude/skills/**`, `CLAUDE.md`

```denylist
vendor/**
packages/core/**
packages/**
.github/workflows/**
scripts/**
plugins/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
docs/first_principles_5_operational_framework.md
.claude/**
```

```allowed-roots
prompts/**
```

## Acceptance criteria

1. **Section present.** `prompts/agent_rules.md` contains a **Coworker CLI delegation** heading.
2. **Profiles (required flags).** Section requires `--profile code` on every `coworker ask` (fixed,
   no per-task override) and `--profile write` on every `coworker write` unless the task issue
   explicitly names a different profile (not “default profile” wording).
3. **Ask triggers.** All four triggers appear with preserved semantics and exact thresholds (600
   lines, 3 files, 200 lines, 2+ docs bootstrap with 600/200 line bounds).
4. **Write scope and safety.** `coworker write` limited to primary doc/boilerplate categories;
   targets inside declared scope only; no truncate-overwrite of existing files unless the task
   authorizes replacement; not for iterative refinement of in-scope implementation code.
5. **Anti-delegation.** All five “do not delegate” cases appear in intent (under-2000-token tasks,
   debug/RCA/safety, architecture/trade-offs, line-precise edits, intent inference).
6. **No untriggered ask.** Section forbids `coworker ask` unless at least one ask trigger holds;
   when none hold, workers use deterministic tools instead (not “tools first, then ask anyway”).
7. **Pickup ordering.** Section states `ao acknowledge` before any `coworker` shell-out in the session.
8. **Accountability.** Worker verifies coworker output, scope, commits, and AO transitions;
   `coworker` must not run `ao-declare`, `ao report`, or open PRs.
9. **File gate and provider-input fence.** Default text-only input for `coworker ask` corpus and
   `coworker write` context; explicit `--allow-code` / `COWORKER_ALLOW_CODE=1` only when the task
   requires code at the cheap provider. File material sent to the provider (corpus/context) is
   repo-originating and non-secret (tracked files or repo-derived diff/log/working-tree output); the
   `--question` / `--spec` prompt carries no secrets. No out-of-tree, external, gitignored, or
   secret-bearing content reaches the provider. Reads may span repo context beyond the editable
   declared scope; writes (`--target`) stay inside it.
10. **Stub (if applicable).** Spawn stub points to worktree rules without contradiction.
11. **Reviewer carve-out.** Section explicitly states that review reasoning is not delegated and
    that the review path (`REVIEW_COMMAND` / `PACK_REVIEWER`) is never routed through `coworker`.
12. `pwsh -NoProfile -File scripts/verify.ps1` passes on the PR head.

## Upgrade-safety check

- Pack-only prompt text; no AO core or vendor edits.
- No new repo secrets; assumes operator-configured local `coworker` and API keys.
- Preserves planner freedom for section order and wording beyond the contract above.
- Does not mandate provider model IDs beyond operator local config.

## Verification

```powershell
Select-String -Pattern 'Coworker CLI delegation|ao acknowledge|--profile code|--profile write|600|2000|ao report|coworker ask|REVIEW_COMMAND|review reasoning' prompts/agent_rules.md
if (Test-Path prompts/agent_rules_spawn_stub.md) {
  Select-String -Pattern 'coworker|Coworker' prompts/agent_rules_spawn_stub.md
}
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
```

Manual (optional): one session delegates a >600-line markdown corpus via `coworker ask --profile code`;
a sub-2000-token single-file question stays on the reasoning model.
