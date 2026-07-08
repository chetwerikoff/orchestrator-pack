GitHub Issue: #682

## Prerequisite

- `docs/issues_drafts/226-ao-harness-pack-pn-contract-unification.md` (GitHub #658) —
  *already does:* adds the pack pre-trigger reviewers guard (AC#6) that reads project
  config and refuses the batch trigger when `reviewers[0].harness` is not `codex`. That
  guard is the caller of the config read this draft corrects. **This draft does not touch
  #658's enforcement design** — only the endpoint the read uses.
- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub #623, merged) —
  *already does:* AO 0.10 review lifecycle, the `ao-review` daemon-HTTP shim library,
  and `ProjectConfig.reviewers[].harness` selection. This draft edits one read helper in
  that shim library.

**Prior-art verdict (draft-author recon, 2026-07-08):** genuinely-new bugfix. The broken
read helper is unique to #658's AC#6 pre-trigger guard; no open or merged draft owns the
project-config read endpoint. Confirmed live 2026-07-08: the correct read endpoint returns
the reviewers datum, the currently-used endpoint does not (evidence below).

## Goal

The pack pre-trigger reviewers guard reads project configuration from the AO daemon
endpoint that is **live-supported** and extracts the `reviewers` list from it, so the
guard executes instead of throwing before the review batch is triggered. The guard's
regression test binds to a **live-shape fixture** — a project object with nested
`config.reviewers` — so the wrong endpoint or wrong selector cannot pass the suite green
again.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

- **Config read endpoint (corrected).** The pre-trigger guard's project-config read
  resolves the `reviewers` list from the response of `GET /api/v1/projects/{id}`. The live
  daemon wraps the project object under a top-level `project` key, and the `reviewers` list
  lives in that project object's `config` — i.e. at `.project.config.reviewers` in the
  response body (equivalently: unwrap `.project`, then select `config.reviewers`). The
  contract-evidence selector below (`$.project.config.reviewers`) is the authoritative
  shape; any prose mention of `config.reviewers` in this draft means that same list under
  the unwrapped project object, never a top-level `reviewers` key of a `/config` response.
  The previously-used read of `GET /api/v1/projects/{id}/config` is not live-supported
  (returns HTTP 405 `method_not_allowed`; confirmed live 2026-07-08) and must no longer be
  the read the guard depends on.
- **Reviewer-write path left as-is (probe result).** The reviewer-harness write helper
  issues `PUT /api/v1/projects/{id}/config`. Live probe 2026-07-08: that method is
  **supported** on the same path — a `PUT` with a rejected body returns HTTP 400
  `INVALID_JSON` (the route handler is reached and parses the body), not 405. Only the
  `GET` verb on the `/config` subpath is rejected. This draft therefore leaves the
  reviewer-write helper unchanged; the correction is confined to the read helper.
- **Live-shape regression evidence.** The guard's regression test consumes a fixture in
  the exact shape the live daemon serializes for a single project — the response wrapping
  the project under `.project`, with the `reviewers` list at `.project.config.reviewers`,
  not at a top-level `reviewers` key of a `/config` response. A fixture asserting the old
  top-level shape must not satisfy the test.
- **Guard decision unchanged.** The guard's abort/allow decision, its expected-harness
  value (`codex`), and its refuse-on-misconfig behavior are unchanged. This draft changes
  only where the config datum is read from and how the `reviewers` list is selected out
  of it.

```contract-evidence
binding-id: ao:projects-single:config-reviewers
binding-type: structured
binding: GET /api/v1/projects/{id} returns the reviewers list nested at .project.config.reviewers on the live-supported endpoint
producer: ao-0-10-daemon
evidence: capture@ao-0-10-daemon/project-single-reviewers
selector: $.project.config.reviewers[0].harness
expected: codex

binding-id: ao:projects-config-get:method-not-allowed
binding-type: structured
binding: GET /api/v1/projects/{id}/config is not live-supported and returns a method_not_allowed error code
producer: ao-0-10-daemon
evidence: capture@ao-0-10-daemon/project-config-get-405
selector: $.code
expected: METHOD_NOT_ALLOWED
```

## Files in scope

- `scripts/lib/**` — the daemon-HTTP shim helper that reads project config for the
  pre-trigger guard (correct the read endpoint and the `reviewers` selector).
- `tests/**` — the guard's regression test and its live-shape project fixture `(update)`.
- `tests/external-output-references/**` — the capture-backed project-object fixture, if
  the regression test binds to the shared capture corpus `(update if needed)`.

## Files out of scope

- `scripts/invoke-pack-review.ps1` — frozen manual entry, unchanged.
- The reviewer-harness **write** helper (`PUT …/config`) — supported per the live probe;
  no change.
- #658's pre-trigger guard **decision logic**, its enforcement design, and the broader
  `[Pn]` harness contract — owned by #658 and its revision.
- `vendor/**`, `packages/core/**`, `.ao/**`, `agent-orchestrator.yaml`.
- Any change to the AO daemon or its endpoints (read-only correction on the pack side).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/lib/**
tests/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Corrected read endpoint.** The pre-trigger guard's project-config read calls
   `GET /api/v1/projects/{id}` and selects the `reviewers` list at `.project.config.reviewers`
   in the response (unwrap `.project`, then `config.reviewers`). It no longer calls
   `GET /api/v1/projects/{id}/config`. Provable by a test asserting the read helper's
   request path and its selector on the live-shape fixture.

```positive-outcome
asserts: the pre-trigger guard reads a live-shape single-project response and extracts reviewers[0].harness = codex from .project.config.reviewers, allowing the guard to reach its decision instead of throwing
input: realistic
```

2. **Live-shape fixture regression.** The guard's regression suite uses a project fixture
   whose `reviewers` list is at `.project.config.reviewers` (project wrapped under
   `.project`). A fixture using the old top-level `reviewers` shape of a `/config`-style
   response fails the test (red-then-green: fails while the helper reads the wrong endpoint
   or selects the wrong key).

```positive-outcome
asserts: the regression test fails when the config read binds to the top-level reviewers shape and passes only when it selects config.reviewers from the single-project object
input: realistic
```

3. **Guard reaches a decision end-to-end.** With a correctly-configured project
   (`reviewers[0].harness = codex`), the pre-trigger guard completes its read and returns
   its allow decision without throwing. With `reviewers` absent or a non-`codex` harness,
   it still returns its existing refuse/abort decision (behavior preserved).

4. **Reviewer-write helper unchanged.** The `PUT …/config` reviewer-write helper is
   untouched; any existing test over it stays green. The draft records the live probe
   showing `PUT` is supported (400 on bad body, not 405) as the basis for leaving it alone.

## Upgrade-safety check

- No AO core / vendor edits; the correction is a read-endpoint and selector change in the
  pack daemon-HTTP shim, plus test/fixture updates.
- No new repo secrets. The captured project object used as evidence is redacted of the
  embedded GitHub token before it enters the capture corpus (documented in the capture's
  sidecar scrub log).
- No change to the guard's decision contract or the reviewer-write path.

## Verification

1. Guard regression suite green with the live-shape fixture (AC#1–#3).
2. Reviewer-write helper test green, unchanged (AC#4).
3. `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/235-harness-pretrigger-config-read-endpoint-fix.md`
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/235-harness-pretrigger-config-read-endpoint-fix.md`
5. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/235-harness-pretrigger-config-read-endpoint-fix.md`
6. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/235-harness-pretrigger-config-read-endpoint-fix.md`

### Grounding probes (draft-author, live 2026-07-08, AO 0.10.2 daemon port 3001)

Real captures in the committed corpus (`tests/external-output-references/`), not fabricated:

```
GET /api/v1/projects/orchestrator-pack            -> HTTP 200; .project.config.reviewers = [{"harness":"codex"}]
GET /api/v1/projects/orchestrator-pack/config     -> HTTP 405 {"error":"method_not_allowed", "message":"GET not allowed on /api/v1/projects/orchestrator-pack/config"}
OPTIONS /api/v1/projects/orchestrator-pack/config -> HTTP 405 method_not_allowed
PUT /api/v1/projects/orchestrator-pack/config     -> HTTP 400 {"error":"bad_request","code":"INVALID_JSON"}  (method supported; body rejected before apply)
```

The `GET`/`config` 405 is why the pre-trigger guard threw before triggering in the PR#673
smoke; the `PUT` 400 (not 405) is why the reviewer-write helper is left unchanged.

