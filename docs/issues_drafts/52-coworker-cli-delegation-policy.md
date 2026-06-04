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
numeric **ask** triggers, category-bounded **write** scope, and an exception list so every AO worker
applies the same cost-aware boundaries.

The operating principle is **"delegate I/O, keep reasoning"**: bulk reading and summarising goes to
the cheap model; analysis, judgment, and conclusions stay on the reasoning model. This split is
**mandatory wherever there is no critical quality loss**, not an optional optimisation — so the rule
states *when delegation is required*, not merely when it is *allowed*. Two failure modes the section
must close:

- **Task-type over-suppression.** A worker labels the whole task "debugging / root-cause" and
  therefore keeps even safe bulk reading on the expensive model. The do-not-delegate boundary must
  govern the **reasoning/output step**, not the task category: gathering evidence for an RCA task is
  still I/O and stays delegable.
- **Source over-restriction.** A worker treats only tracked repo files as sendable and so inlines
  large out-of-tree operational evidence (runtime logs, process output, query dumps) on the
  expensive model. The fence gates on **sensitivity** (secrets/credentials and personal/third-party
  private data), not on file origin.

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

### When an ask trigger holds, `coworker ask` (with `--profile code`) is required, not optional

Read delegation is a **floor**, not a ceiling. When **at least one** ask trigger below holds **and**
the corpus can be made fence-clean (per the provider-input fence) **and** the work is not on the
closed do-not-delegate list, the worker **MUST** route the read through `coworker ask` rather than
inline it on the reasoning model. The triggers bound *when delegation becomes mandatory*; they are
not permission the worker may decline for convenience. (Below every trigger, no trigger holds →
deterministic repo tools; see **Ordering**.)

**Obligation is normative; enforcement stays advisory.** Consistent with the fan-out decision
(§S) and draft 53, this MUST is a **prompt-level obligation** with **no hard hook** — the backstops
are the visible-delegation-outcome status (below), reviewer judgment, and operator observation, not a
`beforeShellExecution` gate. "Mandatory" raises the default from *may* to *must*; it does not claim
machine enforcement.

**Bounded fallback (the floor yields, it does not silently fail).** The worker falls back to
deterministic in-session reading — and **states the reason** in its final status — only when one of
these **closed** cases holds: `coworker` is missing / unavailable / rate-limited; or the corpus
cannot be made fence-clean (secrets or personal/third-party data cannot be scrubbed without losing
the needed signal). Cost/size is **not** a fallback ground: a fired trigger means the corpus is
already above the cost threshold, so "too small to bother" cannot apply once a trigger holds (that
case lives below the floor, under **Ordering**). The fallback is the listed-exception path, not a
discretionary opt-out for convenience.

Ask triggers (any one is sufficient):

- Combined corpus for one question is **more than 600 lines** across all paths in that invocation.
- **3 or more files** under one question (same `coworker ask` call).
- Diff or log material to summarize is **more than 200 lines**.
- Bootstrap read of **2 or more config/doc paths** that together total **more than 600 lines** (or
  each path is **more than 200 lines**) where bulk read is the work, not synthesis.

These triggers count **all** corpus the worker would otherwise read on the reasoning model,
regardless of file origin — out-of-tree operational evidence (runtime logs, process/tmux output,
query dumps captured to a scratch path) counts toward the line/file thresholds exactly like tracked
files, subject only to the provider-input fence below.

**Provider-input fence (file origin does not gate the corpus; sensitivity does):** the worker MUST
NOT send to the external provider — `coworker ask` corpus or `coworker write` context — two classes,
**regardless of file origin**:

- **Secrets/credentials** — API keys, tokens, passwords, private keys, auth headers/cookies, raw
  `.env` values, or any string that grants access.
- **Personal or third-party private data** — PII, customer/end-user data, and private content
  belonging to anyone other than this system's own operation, unless the task issue explicitly
  authorizes it.

Subject to those two prohibitions, **origin is not a gate**: any non-secret, non-personal material
the task needs is sendable — tracked repo files, repo-derived `git diff` / `git log` / working-tree
output, **and** this system's own out-of-tree operational evidence: runtime logs, process/tmux
output, AO activity-DB query results, and similar local diagnostic captures. Internal operational
detail (hostnames, paths, session IDs, our own reviewer findings) is **not** in the prohibited
classes and may be sent when the task needs it.

Because logs and dumps routinely carry prohibited material, the worker is **accountable for the
scrub** before shell-out and sends the **minimal excerpt** the question needs, not whole files
wholesale: confirm the material is free of secrets and personal/third-party data, redacting first.
**When in doubt, treat the material as prohibited** — send only a redacted excerpt, or keep that
portion on the reasoning model. The required `--question` / `--spec` prompt is worker-authored task
text and obeys the same prohibitions; it need not be a repo file.

**Reconciliation with draft 51 (one boundary, two cases):** draft 51’s declared-scope bound governs
delegated helpers that **edit or act** (subagent/Task launches accountable for merged edits).
`coworker ask` performs **no edit** — it only reads — so its corpus is governed by the provider-input
fence above; for *reads* the corpus may span repo context and permitted out-of-tree evidence beyond the
worker’s editable declaration without violating draft 51 (no out-of-scope edit occurs). `coworker
write --target` **is** an edit and stays inside the active declared scope per both drafts. So:
writes/edits → declared scope; reads → provider-input fence only.

### Delegate `coworker write` (with `--profile write`) only for primary drafts

- README, install docs, configuration reference (first cut).
- Standard boilerplate: LICENSE, `.gitignore`, CI workflow yaml skeletons.
- **Declared scope only:** every `--target` path MUST be inside the worker’s active declared scope.
- **Provider input fenced:** any context/input fed to `coworker write` obeys the **provider-input
  fence** above in full — no secrets/credentials, and no personal or third-party private data unless
  the issue authorizes it. Write context is sent to the external provider, so the same two-class
  prohibition and minimal-excerpt rule apply.
- **Non-destructive:** delegate only when the target does **not** exist yet, or the task issue
  explicitly authorizes replacing that file. Upstream `coworker write` truncate-writes by default —
  do not use it to overwrite an existing README, LICENSE, `.gitignore`, or workflow file unless
  replacement is in scope. Prefer `--stdout` and let the worker apply the diff when the target already
  exists.

### The exception list governs the reasoning step, not the task type

This is a **closed list of reasoning/output steps** that stay on the reasoning model. It does **not**
classify whole tasks: a task that contains an excepted *step* may still have delegable *reading*. The
boundary is "delegate I/O, keep reasoning", applied per step — never "this task is debugging, so
nothing in it may be delegated."

Every item here is a **reasoning/output step independent of corpus size** — none is a cost or volume
threshold, so none can override a fired ask trigger (that size/cost axis lives in **Ordering**, not
here). Steps that stay on the reasoning model:

- The **analysis, conclusions, and judgment** of debugging, root-cause analysis, race reasoning, and
  safety-critical logic. (The *reading* that gathers evidence for these is I/O — it is delegable
  whenever an ask trigger fires and the corpus is fence-clean.)
- Architectural decisions and trade-off reasoning.
- Edits requiring **exact line numbers** or surgical diffs in existing code.
- Inferring user intent or clarifying ambiguous requirements.
- **Review reasoning** — producing or shaping PR-review findings (correctness, security, race,
  logic); the review path (`REVIEW_COMMAND` / `PACK_REVIEWER`) is never routed through `coworker`.

**Worked example (the boundary in practice).** A worker is asked to find the root cause of a failure
and must read ~900 lines across `prompts/agent_rules.md`, a config file, and a runtime log. The 600-line
and 3-file triggers fire. **Correct:** scrub the log fence-clean (secrets and any personal/third-party
data), then `coworker ask --profile code` extracts/summarises the minimal needed excerpt of all three
sources; the worker reasons over the cheap-model summary and writes the
root-cause conclusion itself. **Wrong (the incident this rewrite fixes):** the worker calls the whole
task "root-cause" and inlines all 900 lines on the reasoning model — the *reasoning* exception does
not cover the *reading*.

### Ordering

- When **no** ask trigger is met, use deterministic repo tools (search, read, diff, tests) **instead
  of** `coworker ask` — do not delegate (overhead exceeds benefit below the floor). The
  **under-2000-tokens-of-real-work** heuristic lives here, in the sub-threshold zone: it explains why
  small reads stay in-session, and it **cannot override a fired ask trigger** — once any trigger holds
  the corpus is above the cost floor by definition, so a token estimate does not buy an opt-out.
- When an ask trigger **is** met and the corpus is fence-clean and the work is not an excepted
  reasoning step, delegation is **mandatory** (see the floor above) — the worker does not inline the
  read on the reasoning model.
- The worker's final status **states the delegation outcome**: either that `coworker` was used for
  the bulk repo/log read, or the closed-list reason it was not (below the floor / excepted reasoning
  step / corpus not fence-cleanable / `coworker` missing, unavailable, or rate-limited). This reason
  list matches the bounded-fallback cases and acceptance criterion 10. Silence is non-compliant.

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
5. **Exception list is step-scoped, not task-scoped.** Section states the do-not-delegate cases are
   reasoning/output **steps independent of corpus size** (the analysis/conclusions of debug/RCA/safety,
   architecture/trade-offs, line-precise edits, intent inference, review reasoning) — and explicitly
   that a task containing an excepted step may still have delegable reading. The text does **not**
   classify a whole task as undelegatable because it is "debugging" or "root-cause", and **no** item
   in the list is a cost/size threshold (the under-2000-token heuristic lives in **Ordering** and
   cannot override a fired ask trigger).
6. **Read delegation is a floor (mandatory when triggered).** Section states that when at least one
   ask trigger holds **and** the corpus can be made fence-clean **and** the work is not an excepted
   reasoning step, the worker **MUST** delegate the read (not "may"); below every trigger,
   deterministic repo tools are used instead (not "tools first, then ask anyway"). The MUST is a
   prompt-level obligation with **no hard hook** — consistent with §S / draft 53 advisory enforcement
   — and the section names a **bounded fallback** (coworker missing/unavailable/rate-limited, or
   corpus not fence-cleanable) where deterministic reading is allowed **with the reason stated**, not
   a silent or discretionary opt-out.
7. **Pickup ordering.** Section states `ao acknowledge` before any `coworker` shell-out in the session.
8. **Accountability.** Worker verifies coworker output, scope, commits, and AO transitions;
   `coworker` must not run `ao-declare`, `ao report`, or open PRs.
9. **File gate and provider-input fence (sensitivity-gated, not origin-gated).** Default text-only
   input for `coworker ask` corpus and `coworker write` context; explicit `--allow-code` /
   `COWORKER_ALLOW_CODE=1` only when the task requires code at the cheap provider. The hard input
   prohibitions are **two classes, regardless of file origin**: (a) secrets/credentials (keys, tokens,
   passwords, private keys, auth headers, raw `.env` values); (b) personal or third-party private data
   (PII, customer/end-user data, others' private content) unless the issue authorizes it. Origin is
   **not** a gate: this system's own out-of-tree operational evidence (runtime logs, process/tmux
   output, AO activity-DB query results) **is** sendable, and internal operational detail (hostnames,
   paths, session IDs, our own reviewer findings) is not prohibited. The worker is accountable for
   scrubbing both prohibited classes first, sends the **minimal excerpt** the question needs, and when
   in doubt treats material as prohibited (redacted excerpt or keep on the reasoning model). The
   `--question` / `--spec` prompt obeys the same prohibitions. Reads may span repo context and
   permitted out-of-tree evidence beyond the editable declared scope; writes (`--target`) stay inside it.
10. **Visible delegation outcome.** Section requires the worker's final status to state the delegation
    outcome — `coworker` used for the bulk repo/log read, or the closed-list reason it was not (below
    the floor / excepted reasoning step / corpus not fence-cleanable / coworker unavailable). Silence
    is non-compliant. This self-report is the advisory backstop for the floor, not a hard gate.
11. **Stub (if applicable).** Spawn stub points to worktree rules without contradiction.
12. **Reviewer carve-out.** Section explicitly states that review reasoning is not delegated and
    that the review path (`REVIEW_COMMAND` / `PACK_REVIEWER`) is never routed through `coworker`.
13. `pwsh -NoProfile -File scripts/verify.ps1` passes on the PR head.

## Upgrade-safety check

- Pack-only prompt text; no AO core or vendor edits.
- No new repo secrets; assumes operator-configured local `coworker` and API keys.
- Preserves planner freedom for section order and wording beyond the contract above.
- Does not mandate provider model IDs beyond operator local config.

## Verification

```powershell
Select-String -Pattern 'Coworker CLI delegation|ao acknowledge|--profile code|--profile write|600|2000|ao report|coworker ask|REVIEW_COMMAND|review reasoning|secret|scrub|redact|MUST|delegate I/O' prompts/agent_rules.md
if (Test-Path prompts/agent_rules_spawn_stub.md) {
  Select-String -Pattern 'coworker|Coworker' prompts/agent_rules_spawn_stub.md
}
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
```

Manual (optional): one session delegates a >600-line corpus that mixes tracked docs and a scrubbed
out-of-tree runtime log via `coworker ask --profile code`, and its final status names the delegation;
a sub-2000-token single-file question stays on the reasoning model.
