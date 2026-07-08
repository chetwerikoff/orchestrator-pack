# Redaction gate for AO CLI captures must cover the full GitHub-token family and credential-in-URL class

GitHub Issue: #637

## Prerequisite

- `docs/issues_drafts/206-ao-010-session-status-readers-migration.md` (GitHub #619, closed) — already ships the AO 0.10 capture redaction gate `scripts/check-ao-0-10-cli-capture-redaction.ps1` (its AC#12), which scans `tests/external-output-references/captures/ao-0-10-cli/*.raw.json` against a forbidden-pattern list (home paths, `.ao` paths, `Bearer`, `ghp_`, `github_pat_`, `sk-`, `AKIA…`). This draft **extends that list**; it does not change what the gate scans or its pass/fail contract.
- Prior art — existing redaction pattern lists elsewhere in the pack (recon-confirmed, **not** producers of this capture directory): `scripts/lib/contract-evidence-reverify.ts` (scrubs reviewer/contract-evidence text; its regex already covers `sk|ghp|gho|github_pat|xox…` and `AKIA…`) and `scripts/lib/reviewer-contract-mapping.ts` (mapping-preflight scrub; covers `ghp_`, `gho_`, `AKIA…`, Bearer). These redact **different corpora** (reviewer failure evidence, contract-evidence text), not the AO CLI capture directory, and do not require a producer contract to be co-designed with this gate — so this remains a single, self-contained gate extension.
- Prior-art verdict: **extends existing** (#619). No open issue or un-synced local draft covers the missing token/credential-URL coverage; no capture producer/scrubber writes the `ao-0-10-cli` directory (captures are committed manually and only validated post-hoc by this gate).

## Goal

The AO CLI capture redaction gate rejects the **whole class** of GitHub tokens and the **whole class** of credentials embedded in a URL, not only the two prefixes it currently lists. Concretely: any capture containing a GitHub token-family prefix (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) or a `scheme://user:secret@host` credential-in-URL fails the gate regardless of the secret's prefix, and the gate proves — by its own self-test — that it fails on each such class rather than silently degrading if a pattern is dropped later. This is preventive: issues that snap new CLI-output captures (e.g. review producer/panel work) must not be able to commit an AO OAuth token (`gho_…`) or a credential URL that today's list would wave through.

```behavior-kind
action-producing
```

```complexity-tier
tier: T1
advisory-prior: T1
```

## Binding surface

- The forbidden-pattern set of `scripts/check-ao-0-10-cli-capture-redaction.ps1` covers the full GitHub token family and the credential-in-URL class, in addition to everything #619 already forbids (no coverage is removed).
- A negative self-test asserts the gate fails on a fixture containing each pattern class; the self-test does **not** add token-bearing fixtures to the scanned capture directory.
- The gate's pattern-matching is invocable by the self-test against a fixture **outside** the live capture directory — the mechanism (an optional directory/input parameter, a shared exported pattern constant the test imports, or a throwaway temp scanned directory seeded and torn down by the test) is the implementer's choice.
- The gate's pass/fail contract, its default capture directory, and the committed captures are unchanged for real (clean) input; the out-of-dir invocation path is additive and used only by the self-test.

## Operator adoption

None. The gate runs in the existing CI scope-guard lane; there is no operator-facing surface, env var, or process change.

## Files in scope

- `scripts/check-ao-0-10-cli-capture-redaction.ps1` — broaden the forbidden-pattern list to the GitHub token family and the credential-in-URL class; keep every existing pattern.
- Pack-owned negative self-test and any fixture it needs, placed **outside** `tests/external-output-references/captures/ao-0-10-cli/`, plus the CI/verify wiring that keeps the self-test running. (new)

## Files out of scope

- AO daemon behavior — that `ao project get --json` stores/emits a live `gho_` token inside `project.repo` (`https://<user>:gho_…@github.com/…`) is upstream AO store behavior, not a pack surface. Not fixed here.
- Rotation of any currently-live AO OAuth token — an operator action, not a PR.
- Git-history leak audit — captures are clean as of 2026-07-06 and a `project get` capture has never existed; no history rewrite is in scope.
- Consolidating the two `scripts/lib` scrubber pattern lists with this gate — see Decisions; deferred, not required for this gate to be correct.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

1. **GitHub token family caught:** a fixture containing any of `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` (whatever pattern form the implementer chooses — one union pattern or an enumerated set) drives the gate's matching to a detected/non-zero result for each prefix. Proven by the negative self-test (a pack-owned check that invokes the gate's matching against an out-of-dir fixture — see Binding surface), red-then-green: the self-test fails against the pre-draft pattern list (`gho_`, `ghu_`, `ghs_`, `ghr_` slip through) and passes against the broadened list.

```producer-emission
producer: orchestrator-pack
datum: capture-redaction-gate
expected: github-token-family-rejected
proof-command: pwsh -NoProfile -File scripts/check-ao-capture-redaction-selftest.ps1
red-then-green: the self-test detects every GitHub token-family prefix after this draft; run against the pre-draft pattern list, gho_/ghu_/ghs_/ghr_ go undetected and the self-test fails
```

2. **Credential-in-URL class caught:** a fixture containing `scheme://user:secret@host` drives the gate's matching to a detected/non-zero result **regardless of the secret's prefix** — this is the actual shape of the observed leak and the insurance against future token formats.

```producer-emission
producer: orchestrator-pack
datum: capture-redaction-gate
expected: credential-in-url-rejected
proof-command: pwsh -NoProfile -File scripts/check-ao-capture-redaction-selftest.ps1
red-then-green: the self-test detects scheme://user:secret@host after this draft; run against the pre-draft pattern list it goes undetected and the self-test fails
```

3. **Negative self-test proves each class:** an automated test (the `proof-command` above, name illustrative) feeds a fixture containing every pattern class — each GitHub token-family prefix and the credential-in-URL form — through the gate's matching logic and asserts a detected result for each class, so a later silent deletion of any one pattern fails CI. The self-test drives matching against a fixture **outside** the scanned `ao-0-10-cli` capture directory (per Binding surface); it must not place token-bearing fixtures inside that directory.

4. **Duplication decision recorded:** the implementer confirms by recon whether any capture producer/scrubber writes the `ao-0-10-cli` directory and records the disposition of the two existing `scripts/lib` scrubber pattern lists (`contract-evidence-reverify.ts`, `reviewer-contract-mapping.ts`) — consolidate into one shared source, or keep separate with a one-line rationale — in the draft/PR decision trail. A pattern list living in a third place without an explicit decision is itself the finding this criterion closes.

5. **No regression on clean input:** the existing committed captures and the CI scope-guard lane stay green — the broadened patterns (especially credential-in-URL) produce no false positive on any currently-committed capture, and every pattern #619 already forbids still fails as before.

```positive-outcome
asserts: given a fixture containing a gho_ OAuth token embedded as https://user:secret@host, the gate reaches a fail (non-zero) result and names at least one matched forbidden pattern — the input is caught, whichever class matches first
input: realistic
```

## Upgrade-safety check

Upgrade-safe: the change stays entirely within a pack-owned check script and pack-owned test/fixture surfaces. No AO core, vendor, or `packages/core` edits; no unsupported YAML; no new repo secret is introduced (fixtures use fabricated non-live token bodies of realistic shape).

## Verification

- Run the gate against a fixture bearing each GitHub token-family prefix and the credential-in-URL form: exits non-zero and names the matched pattern (AC#1, AC#2).
- Run the negative self-test: passes after the draft, and demonstrably fails if any class pattern is removed from the list (AC#3).
- Run the gate against the existing committed captures: `[PASS]`, no false positive (AC#5).
- Decision trail (draft/PR) records the capture-producer recon result and the two-`scripts/lib`-scrubber duplication disposition (AC#4).

```contract-evidence
binding-id: orchestrator-pack:capture-redaction-gate:github-token-family-rejected
binding-type: cli-behavior
binding: the AO CLI capture redaction gate exits non-zero and names the matched pattern when a capture contains any GitHub token-family prefix (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:capture-redaction-gate:credential-in-url-rejected
binding-type: cli-behavior
binding: the AO CLI capture redaction gate exits non-zero when a capture contains a scheme://user:secret@host credential-in-URL, independent of the secret's prefix
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
```

## Decisions

- Prior art: the redaction gate is #619's AC#12; two other scrubbers (`contract-evidence-reverify.ts`, `reviewer-contract-mapping.ts`) already encode the GitHub-token class for reviewer/contract-evidence text but not for the `ao-0-10-cli` capture directory. This draft only broadens the existing gate's list — it does not rebuild redaction machinery.
- Pattern-form choice is left to the implementer (a single token-family union regex vs. an enumerated prefix set; a credential-in-URL regex). The contract is the class caught, not the regex text — planner freedom.
- Consolidating the three pattern lists into one shared module is **out of scope**: the two `scripts/lib` scrubbers redact different corpora and consolidating them would couple unrelated surfaces; the correct minimal move is to close the gate's gap now and record the duplication so a future task can decide on consolidation with full context (AC#4).
- Tier T1: a mechanical denylist string-match extension plus a self-test, with low coupling and no cross-surface coordination. The advisory escalation-to-T2 condition (a capture producer with its own redaction logic requiring contract coordination) did not hold — recon found no such producer for this directory.