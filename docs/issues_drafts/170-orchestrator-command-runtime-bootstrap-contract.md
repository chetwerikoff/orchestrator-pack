# Autonomous orchestrator command runtime needs a bootstrap/preflight contract

GitHub Issue: [#532](https://github.com/chetwerikoff/orchestrator-pack/issues/532)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md`
  (GitHub #431, closed by PR #437) shipped the pack `scripts/gh` wrapper and
  inventory-routed REST reads. This draft does not add another REST route; it
  ensures the command runtime reaches the wrapper through a stable environment.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
  (GitHub #447, closed by PR #452) shipped PATH adoption for wake-supervisor
  children. This draft covers autonomous orchestrator command turns and
  operator-requested command execution, not only supervised children.
- `docs/issues_drafts/160-gh-rest-allowlist-review-forms-and-universal-wrapper-rule.md`
  (GitHub #501, closed by PR #503) shipped the rule that GitHub reads go through
  pack `scripts/gh` and inventory-listed canonical forms.
- `docs/issues_drafts/168-gh-rest-rca-read-allowlist-and-static-guard.md`
  (GitHub #520, closed by PR #523) shipped REST coverage for canonical RCA/review
  read forms. This draft may reuse that static-guard pattern but does not reopen
  #520.
- `docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md`
  (GitHub #530, open) and GitHub #531 track the current REST inventory gap for
  `scm-github.resolvePR` / six-field `prInfoFromView`. This draft explicitly
  does not implement that route.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
  (GitHub #522, open) and GitHub #527 track sanctioned autonomous worker
  recovery. This draft does not implement cleanup/respawn recovery; it prevents
  command-runtime failures from pushing agents toward ad hoc wrappers and shell
  bypasses.
- `docs/issues_drafts/41-ubuntu-scripts-portability.md` (GitHub #118, prior
  portability work) is older, broader portability work. This draft owns the
  live autonomous command-runtime preflight gap observed on 2026-06-29.

**Prior-art verdict:** **Extends #431/#447/#501/#520 and complements #530/#522**.
Existing work covers `gh` REST routing and some child PATH adoption, but no open
issue owns the autonomous command runtime contract that checks `pwsh`/PATH/tool
availability and fails closed before an agent writes temporary wrappers.

**Incident note (2026-06-29):** During an autonomous orchestrator turn, the live
terminal showed `pwsh: command not found` with a PATH diagnostic, then the agent
created/rewrote `/tmp/gh-rest-bin/gh` and added a temporary REST unblock branch in
`scripts/gh` because bash stderr polluted PowerShell JSON parsing. The REST
argv itself belongs to #530; the missing durable contract here is command
runtime bootstrap and fail-closed diagnostics.

**Knowledge-base note:** Local wiki notes `Baseline`, `Build-time dependency`,
and `Version control` reinforce that execution environments and toolchain
dependencies must be reproducible, version-controlled/tested, and checked before
use. Synto returned no relevant article/source segment.

## Goal

Give autonomous orchestrator command execution a checked, observable runtime
bootstrap contract so required tools and PATH are validated before side effects,
stderr cannot corrupt structured command parsing, and uncovered `gh` argv shapes
are reported for inventory extension instead of handled by temporary wrappers or
hand-built REST branches.

```behavior-kind
action-producing
```

## Binding surface

- The autonomous orchestrator command-runner environment that executes
  operator-requested and worker/recovery shell commands.
- PATH construction for those command turns, including pack `scripts/`, the host
  directories needed to find `pwsh` and `node`, and the terminal native `gh`
  target used by pack `scripts/gh`.
- Preflight checks for runtime dependencies used by pack workflows: at minimum
  `pwsh`, `node`, pack `scripts/gh`, and a resolvable native `gh` terminal target.
- Structured-output parsing for command wrappers that shell through PowerShell or
  JSON-producing scripts. stderr must be separated, scrubbed, or rejected before
  it can be parsed as stdout JSON.
- Agent-facing guardrails for uncovered GitHub read forms: report the argv shape
  for inventory extension and fail closed; do not write `/tmp/gh-rest-bin/gh`,
  direct bash REST branches, raw `curl api.github.com`, `gh api graphql`, or
  `unset GH_WRAPPER_ACTIVE` bypasses.

## Files in scope

- `scripts/**`
- `plugins/**`
- `prompts/**`
- `docs/**`
- `.github/workflows/**` only if needed for reusable verification wiring
- `agent-orchestrator.yaml.example`

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `.agent-orchestrator/**`
- Local credential files, shell dotfiles, and machine-local secrets
- Implementing #530/#531 `resolvePR` REST routing
- Implementing #522/#527 sanctioned worker recovery
- Changing Composio AO core packages

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
node_modules/**
```

Scope boundary note: this denylist is scoped to
`170-orchestrator-command-runtime-bootstrap-contract`.

```allowed-roots
scripts/**
plugins/**
prompts/**
docs/**
.github/workflows/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Command-runtime preflight exists and runs before action.** A script or
   reusable helper checks the actual environment used by autonomous orchestrator
   command turns before any side-effecting command runs. It verifies `pwsh`,
   `node`, pack `scripts/gh`, native `gh` terminal resolution, and the effective
   PATH entries needed for those tools.

```producer-emission
producer: orchestrator-pack
datum: command-runtime-bootstrap
expected: preflight-before-side-effects
proof-command: implementation-specific focused command-runtime preflight test
```

2. **Missing `pwsh` / incomplete PATH fails closed with a deterministic
   diagnostic.** A fixture reproduces an environment where `pwsh` is not found
   because PATH is incomplete. The preflight exits non-zero before any
   side-effecting command and emits a stable diagnostic naming the missing tool
   and effective PATH class. It does not ask the agent to edit shell dotfiles,
   create a temp wrapper, or bypass the command.

```producer-emission
producer: orchestrator-pack
datum: command-runtime-bootstrap
expected: missing-pwsh-path-fail-closed
proof-command: implementation-specific focused PATH/pwsh fixture
```

3. **Pack `gh` and native terminal `gh` are both validated.** A fixture proves
   the command runtime resolves `gh` first to pack `scripts/gh` while
   `scripts/lib/gh-resolve-real-binary.mjs` can still find a non-wrapper native
   terminal target. If only wrapper shims are reachable, the preflight fails with
   the existing #442/#467-style terminal-resolution diagnostic instead of
   recursing or fabricating a new wrapper.

4. **stderr cannot corrupt structured JSON parsing.** A fixture reproduces a
   wrapper that writes harmless stderr before JSON stdout (matching the observed
   bash debugger warning class). The command path either keeps stderr separate
   from stdout parsing or fails with a deterministic `structured_output_polluted`
   diagnostic. It must not treat mixed stderr/stdout as valid JSON.

```producer-emission
producer: orchestrator-pack
datum: command-runtime-bootstrap
expected: structured-output-stderr-safe
proof-command: implementation-specific focused stderr/stdout fixture
```

5. **Uncovered `gh` argv shapes become inventory reports, not temp shims.** When
   an uncovered GitHub read form is encountered, the command runtime or
   agent-facing rule tells the agent to report the argv shape for inventory
   extension and use a REST endpoint only as an operator-visible one-off
   diagnostic. It must not authorize persistent `/tmp/gh-rest-bin/gh`, raw
   `curl`, `gh api graphql`, `unset GH_WRAPPER_ACTIVE`, or direct bash REST
   branches in `scripts/gh`.

```producer-emission
producer: orchestrator-pack
datum: command-runtime-bootstrap
expected: no-temp-gh-wrapper-workaround
proof-command: implementation-specific prompt/static guard or focused command-runtime diagnostic test
```

6. **Static guard rejects forbidden workaround instructions.** Verification
   scans agent-facing prompts/rules/scripts for executable instructions that
   recommend temporary `gh` wrappers, raw `curl api.github.com`, GraphQL
   fallback, `unset GH_WRAPPER_ACTIVE`, or hand-built REST branches outside the
   inventory matcher/routes. Prose describing the 2026-06-29 incident may be
   allowlisted only when clearly non-executable.

```producer-emission
producer: orchestrator-pack
datum: command-runtime-bootstrap
expected: forbidden-workaround-static-guard
proof-command: implementation-specific static guard check
```

7. **Current temporary REST unblock is not legitimized.** The implementation
   records the current `scripts/gh` operator REST unblock as temporary local
   state owned by #530/#531. This issue must not mark that branch as accepted
   architecture; if the branch remains present at closure, the closure notes must
   say #530/#531 still owns removal.

8. **No duplicated recovery path.** Any command-runtime failure that implies
   worker cleanup/respawn routes to #522/#527 or emits a deterministic blocked
   diagnostic. This draft must not add `SURFACE=0`, raw git, `worktree remove`,
   or alternate cleanup recipes.

```positive-outcome
asserts: an autonomous orchestrator command turn with missing pwsh or incomplete PATH fails before side effects with a deterministic diagnostic, while a normal environment reaches pack scripts/gh and native gh without temp wrappers or GraphQL fallback
input: realistic
provenance: sample-backed
```

```contract-evidence
binding-id: orchestrator-pack:command-runtime-bootstrap:preflight-before-side-effects
binding-type: cli-behavior
binding: autonomous command runtime checks required tools and PATH before side-effecting commands
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:command-runtime-bootstrap:missing-pwsh-path-fail-closed
binding-type: cli-behavior
binding: missing pwsh or incomplete PATH produces a deterministic fail-closed diagnostic before action
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:command-runtime-bootstrap:structured-output-stderr-safe
binding-type: cli-behavior
binding: stderr from shell wrappers cannot be parsed as stdout JSON
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:command-runtime-bootstrap:no-temp-gh-wrapper-workaround
binding-type: cli-behavior
binding: uncovered gh read forms are reported for inventory extension and do not authorize temp wrappers or GraphQL/curl fallback
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:command-runtime-bootstrap:forbidden-workaround-static-guard
binding-type: cli-behavior
binding: agent-facing prompts/rules/scripts reject executable temp-wrapper, GraphQL, curl, and direct REST-branch workaround instructions
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)
```

## Upgrade-safety check

- No edits to Composio AO core or vendored packages.
- No local shell dotfile edits, credential changes, or machine-local secrets.
- The pack `scripts/gh` inventory architecture remains the durable REST path.
- The issue does not broaden autonomous git/spawn/recovery permissions.
- Failure diagnostics may include tool names and sanitized PATH classes, but
  must not leak secrets or raw credential-bearing environment values.

## Verification

- Focused command-runtime preflight test proving AC#1.
- Missing `pwsh` / incomplete PATH fixture proving AC#2.
- Pack `gh` plus native terminal `gh` resolution fixture proving AC#3.
- stderr/stdout structured-output fixture proving AC#4.
- Static guard for forbidden temp wrapper / GraphQL / curl / direct REST branch
  instructions proving AC#5 and AC#6.
- Closure note or guard proving AC#7.
- Recovery-boundary regression or static assertion proving AC#8.
- `npx vitest run` for any new JS/TS tests added under `scripts/**`.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Prior art

The repo already has durable REST-wrapper work (#431/#447/#501/#520), an open
route issue for the exact `resolvePR` argv (#530/#531), and an open recovery
issue for cleanup/respawn (#522/#527). The uncovered class is the command
runtime itself: missing tools, incomplete PATH, and mixed stderr/stdout create
pressure for the agent to invent temporary wrappers.

### Design options

| Option | Trade-off | Decision |
|---|---|---|
| A. Fold this into #530 | Would ship with the immediate REST route, but mixes argv inventory with runtime bootstrap and leaves non-REST command failures underspecified | Rejected |
| B. Fold this into #522 | Recovery needs a legal cleanup/respawn path, but command preflight applies before many non-recovery commands too | Rejected |
| C. Add a narrow command-runtime bootstrap/preflight contract | Smallest independent fix for missing `pwsh`, PATH drift, and stderr parsing without reopening REST/recovery design | Chosen |
| D. Document operator workaround only | Cheapest now, but preserves the exact behavior that caused temp wrapper invention | Rejected |

### Scenario matrix

| Case | Runtime state | Expected outcome |
|---|---|---|
| 1 | Normal PATH with `pwsh`, `node`, pack `scripts/gh`, native `gh` | Preflight passes; commands run through pack wrapper |
| 2 | PATH missing `pwsh` | Fail closed before side effects; stable diagnostic |
| 3 | PATH finds pack `scripts/gh` but no native terminal `gh` | Fail closed with terminal-resolution diagnostic |
| 4 | PATH finds only wrapper shims for `gh` | Existing #442/#467-style failure, no recursion |
| 5 | Wrapper emits stderr before JSON stdout | stderr separated or deterministic parse rejection |
| 6 | Uncovered `gh` argv under GraphQL exhaustion | Report inventory gap; no temp wrapper or GraphQL fallback |
| 7 | Command failure suggests cleanup/respawn | Route to #522/#527 or blocked diagnostic; no raw recovery recipe |
| 8 | Prompt/script introduces temp wrapper instruction | Static guard fails |
