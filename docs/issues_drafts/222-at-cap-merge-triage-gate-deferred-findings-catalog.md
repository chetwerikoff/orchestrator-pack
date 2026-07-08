# At-cap merge triage gate (BLOCK vs MERGE+DEFER) and deferred-findings catalog

GitHub Issue: #648

## Prerequisite

- `docs/issues_drafts/221-per-tier-review-cycle-cap-early-stop.md` — **must merge first.** Produces the `at_cap_open_findings` terminal state this gate consumes. Below tier cap the review loop is unchanged; this gate is the budget-exhaustion exit only.
- `docs/issues_drafts/204-review-status-consumers-report-full-json-reader.md` (GitHub #611, open) — pack read model for review runs and open findings on AO 0.10.2. Gate logic **consumes** the #611 reader and the pack finding store; it does not shell out to dead `ao review list` argv.
- Shipped finding-bar contract: `docs/issues_drafts/19-codex-review-finding-bar.md` (GitHub #51) — `type: security` and `type: scope-violation` remain material by definition in the review path; this gate does not re-label severities at the source.
- Shipped fail-closed ledger lineage: `docs/issues_drafts/188-per-tier-review-flow-finding-ownership.md` (GitHub #575) — **cited, not copied:** a guard that cannot parse or classify must **fail closed** and must never pass by omission; non-zero exit blocks merge-eligibility promotion.

**Prior-art verdict (draft-author recon 2026-07-07):** **Extends existing, genuinely new capability.** Shipped work owns review cycles (#332), covered-head idempotency (#189), finding-bar vocabulary (#51), and per-tier draft-review ledger guards (#188). Draft 221 adds cap terminals but explicitly defers triage. No queued draft implements BLOCK vs MERGE+DEFER text triage, deferred-findings catalog, or architect adjudication for at-cap PRs. Audit evidence and operator decisions are binding in `docs/investigations/review-criticality-cycle-cap-audit-2026-07-02.md` §4b (2026-07-07).

**Decomposition check:** One PR — gate classifier, verdict journal, deferred catalog, architect adjudication surface, merge-eligibility policy hook. Gate and catalog are one contract (DEFER verdicts are meaningless without durable catalog write); splitting would ship a classifier that cannot complete its outcome.

**Pre-draft design gate (architect brief + audit §2/§4b — carried forward, not re-derived):** Only ~15–25% of P1/blocking findings are true merge-blockers; conditional qualifiers in finding text distinguish deferrable items. Operator decisions (2026-07-07, binding): gate fires **only** at tier cap with open findings; deterministic text rule (no LLM); deferred findings go to a dedicated catalog (not auto-issues); ambiguity and appeals go to the **Claude architect session** (not AO orchestrator LLM-turn, not operator); every verdict is journaled.

## Goal

When a PR reaches `at_cap_open_findings` (draft 221) with open review findings still on the current head, run a deterministic, fail-closed merge-triage gate that classifies each open finding as **BLOCK** or **DEFER**, journals every verdict, routes ambiguity and worker appeals to an architect adjudication surface (operator not required), writes all DEFER findings into a fingerprint-deduped deferred-findings catalog grouped per PR, and exposes a pack-owned **merge-eligibility policy input** so merge-with-local-adoption (and any autonomous merge guard) can allow merge only when zero BLOCK findings remain and no architect verdict is pending — without becoming a new merge executor.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: decision-state-machine, crash-recovery, durable-state-evidence
```

## Binding surface

### Trigger and inputs

The gate runs **only** when a persisted `at_cap_open_findings` record exists for `pr_number` per draft 221's terminal schema, **latched for the PR**. For the current `head_sha`, either the terminal record matches that head **or** the PR is in post-cap remediation (latched at-cap with advanced head per BLOCK continuation / AC#14). Gate classifies open findings on the **current** head. (`schema_version`, `terminal`, `pr_number`, `head_sha`, `tier`, `cap`, `distinct_heads_reviewed`, `open_finding_count`, `cycle_opened_at_utc`, `terminated_at_utc`, `producer`).

**Forbidden:** running triage below cap; running triage without a latched `at_cap_open_findings` record for the PR; re-reading PR code or invoking an LLM for classification.

**Open-finding set:** all findings with `status: open` on the **current PR head** (`head_sha` under evaluation — which may differ from the original `at_cap_open_findings.head_sha` during post-cap remediation), read through the pack finding store (`code-reviews/findings/*.json` under the AO project path) via the #611 read model. Each finding record supplies at minimum: `id`, `title` (with `[P1]`/`[P2]`/`[P3]` prefix), `body` (includes `severity: blocking|non-blocking`, `category`, `details`), `fingerprint`, `runId`, `status`.

**Classification text:** normalized concatenation of `title` + newline + `body` (case-insensitive matching). Planner picks normalization (whitespace collapse, unicode fold). **Matching rule:** seed markers are substring matches on normalized text. When a seed marker ends with `…`, match if normalized text contains the prefix before `…`. When a seed marker contains `…` internally (e.g. `every … classified malformed`), match if normalized text contains both the left and right stems in order. Additionally: `category: scope-violation` or `type: scope-violation` in body, or `[scope-violation]` in title, counts as hitting the `[scope-violation]` DEFER marker.

### Operator decisions (binding — quote in implementation docs, do not relitigate)

1. **Gate fires ONLY when a PR reaches its tier cap (draft 221) with findings still open.** Below cap the loop is unchanged.
2. **Deterministic text rule** (no LLM, no re-reading code):
   **BLOCK** ⇔ the finding asserts, WITHOUT a conditional qualifier, a deterministic main/documented-path failure OR a real secret written to disk / passed to an external provider OR red CI. Everything else → **MERGE + DEFER** (recorded as verdict `DEFER`).
3. **Deferred findings go to a dedicated catalog, NOT auto-created GitHub issues.** All findings open at merge (conditional P1s, P2, P3) are recorded there: fingerprint-deduped, grouped per PR. Promotion to a GitHub issue is a separate deliberate manual step — **out of scope** to automate.
4. **Ambiguity and appeals are adjudicated by the Claude ARCHITECT session** — not the AO orchestrator LLM-turn, not the operator. Ambiguity = finding matches neither or both marker lists; appeal = worker disputes a BLOCK. While a verdict is pending the gate must NOT auto-merge (fail-closed on ambiguity).
5. **Every verdict is journaled** with enough fields for false-merge audit and marker-list recalibration (`finding_id`, `fingerprint`, `pr_number`, `head_sha`, matched rule/marker, verdict, actor, timestamp — exact schema is planner's).

### Initial marker calibration (verbatim seed lists — format/versioning is planner's)

Pack-owned marker list file (versioned; hot-reload optional). Initial `schema_version: 1` content **must** include these literals:

**BLOCK markers:**

- `parser error`
- `ReferenceError`
- `throws before`
- `cannot start`
- `not executable`
- `every … classified malformed`
- `CI will fail`
- `verify.ps1 fails`
- `recorded as successful`
- `looks green`
- `never receives` (main path)
- `written to disk`
- `passed to coworker/provider` (secret context)

**DEFER markers** (operator binding 2026-07-07 — includes conditional trust-boundary and scope-declaration wording from audit §4b; these defer merge debt to catalog, they do not waive #51 protected-finding materiality in the review path):

- `if the process crashes between…`
- `when the head moves between…`
- `under concurrent…`
- `if two live sessions…`
- `TOCTOU`
- `an attacker/autonomous turn can forge/spoof…`
- `when bwrap/unshare is unavailable`
- `on Windows/BSD…`
- any `[scope-violation]`
- `declare the path`
- `sync to issue #N`


**Conditional qualifier veto (operator rule 2):** Before a BLOCK marker can apply, normalized text is scanned for conditional-qualifier stems: `unless`, `if the`, `if `, `when `, `under concurrent`, `between` (when adjacent to crash/move/cut semantics), `on Windows`, `on BSD`. If any stem is present, BLOCK-marker hits are **vetoed** unless the finding also matches unconditional secret-on-disk / false-green-CI BLOCK classes (`written to disk`, `passed to coworker/provider`, `recorded as successful`, `looks green`) which remain BLOCK even with nearby qualifiers. This implements “BLOCK only WITHOUT a conditional qualifier.”

**Matching precedence:**

| Condition | Per-finding verdict |
| --- | --- |
| Matches ≥1 BLOCK marker and **no** DEFER marker | `BLOCK` |
| Matches ≥1 DEFER marker and **no** BLOCK marker | `DEFER` |
| Matches ≥1 BLOCK **and** ≥1 DEFER marker | `PENDING_ARCHITECT` (ambiguity) |
| BLOCK marker hit but conditional-qualifier veto applies (and no unconditional secret/false-green BLOCK class) | `DEFER` |
| Matches neither list | `PENDING_ARCHITECT` (ambiguity) |
| `category: scope-violation` or `type: scope-violation` without BLOCK marker and without denylist/protected-path literals | `DEFER` (operator binding — audit §4b declaration-class; catalog debt; clearance terminal still required) |
| `category: security` with only conditional DEFER markers (e.g. attacker/spoof) and no BLOCK marker | `DEFER` (operator binding — conditional trust-boundary class from audit §2; not merge without clearance + snapshot hashes) |
| Scope-violation with denylist/protected-path literals (`vendor/**`, `packages/core/**`, `.ao/**`, or explicit denylist breach prose) | `BLOCK` (hard path-fence breach — not declaration-class defer) |
| Finding text empty/unparseable after normalization | `PENDING_ARCHITECT`; gate run exits non-zero and emits no clearance (fail-closed; never silently DEFER) |
| Worker filed appeal on a prior `BLOCK` | `PENDING_ARCHITECT` until architect rules |

**Red CI / secret classes:** findings whose normalized text matches BLOCK markers for CI failure, false-green status, disk write, or provider pass are `BLOCK` even when severity label is `non-blocking` — the text rule overrides reviewer severity labels for merge policy only (does not mutate finding records).

### Aggregate PR outcomes

After per-finding classification (and excluding items already `PENDING_ARCHITECT`):

| Aggregate | Merge eligibility | Next action |
| --- | --- | --- |
| ≥1 `BLOCK`, zero `PENDING_ARCHITECT` | **Blocked** | Bounded continuation (below) |
| ≥1 `PENDING_ARCHITECT` (ambiguity or appeal) | **Blocked** (fail-closed) | Architect adjudication surface |
| All open findings `DEFER` | **Eligible** after catalog write | Write catalog + emit clearance terminal |

**Bounded continuation when BLOCK present (author decision):** PR stays merge-blocked and `at_cap_open_findings` remains latched. Deliver **only** the `BLOCK` finding(s) to the worker through the existing finding-delivery path (same channel used for ordinary review sends). This remediation cycle does **not** consume an additional distinct-head budget unit (draft 221 cap semantics). Review auto-start surfaces stay suppressed per draft 221 AC#5/#10 until clearance. Worker may file an appeal instead of fixing; appeal moves the finding to `PENDING_ARCHITECT` and blocks merge until architect verdict.

**Clearance terminal:** when all open findings are `DEFER` and catalog write succeeds, emit pack-owned `merge_triage_cleared` record for `(pr_number, head_sha)` with linkage to the consumed `at_cap_open_findings` record, gate run id, **`marker_list_version`**, **`marker_list_hash`**, and **`open_findings_snapshot_hash`** — a stable hash over the sorted set of `(finding_id, fingerprint, normalized_text)` for all open findings on that head at clearance time. Merge policy **must** recompute `open_findings_snapshot_hash` from the live open-finding set and verify `marker_list_version`/`marker_list_hash` still match the active marker file before allowing merge; any finding-set/text drift **or** marker-list recalibration before merge **invalidates** clearance and requires re-gate. This record is the merge-eligibility policy input alongside draft 221's `clean_early_stop`.


**Head advance under latched at-cap (BLOCK remediation):** When the worker pushes a new `head_sha` after bounded BLOCK continuation while `at_cap_open_findings` remains latched (draft 221 AC#10), the gate **re-runs** for `(pr_number, new_head_sha)` without consuming additional distinct-head budget. If the open-finding set on the new head is empty, emit `merge_triage_cleared` (or equivalent post-cap remediated clearance) and allow merge. If open findings remain, re-classify under the same marker rules. Review auto-start suppression from draft 221 stays in force until clearance.

**Forbidden:** auto-merge inside this module; clearing `at_cap_open_findings` without a successful gate run; merge-eligible promotion when catalog write fails.

### Deferred-findings catalog

- **Ownership:** pack-owned durable storage under operator state (e.g. `~/.local/state/orchestrator-pack/deferred-findings/`), **not** AO-internal DB tables — survives AO upgrades.
- **Durability:** append-oriented store; catalog write failure aborts clearance (fail-closed).
- **Dedup:** composite key `(pr_number, fingerprint)`; re-gate on same head with same key updates metadata (last_seen, run ids) but does not duplicate rows. Cross-PR fingerprint collision keeps distinct rows (AC#10).
- **Grouping:** browsable per `pr_number` (and `head_sha` at deferral time); human-readable summary export optional.
- **Fields (normative minimum per entry):** `fingerprint`, `finding_id`, `pr_number`, `head_sha`, `title`, `severity`, `category`, `details_excerpt` (or full `body` snapshot), `normalized_text_hash`, `gate_verdict: DEFER`, `deferred_at_utc`, `gate_run_id`, `marker_hits[]`, optional `promoted_issue: null`.
- **Out of scope:** auto-promotion to GitHub issues.

### Verdict journal

Append-only pack-owned journal (distinct from catalog). Each row covers gate-classifier and architect-adjudicator verdicts:

| Field | Required | Semantics |
| --- | --- | --- |
| `schema_version` | yes | Starts at `1` |
| `event_kind` | yes | `gate_classifier` \| `architect_adjudication` \| `appeal_filed` |
| `gate_run_id` | yes | UUID per gate invocation |
| `finding_id` | yes | Source finding id |
| `fingerprint` | yes | Finding fingerprint |
| `pr_number` | yes | GitHub PR |
| `head_sha` | yes | Normalized head at verdict time |
| `verdict` | yes | `BLOCK` \| `DEFER` \| `PENDING_ARCHITECT` |
| `matched_markers` | yes | Array of marker strings or `[]` |
| `actor` | yes | `gate` \| `architect` \| `worker` |
| `actor_session` | yes for `actor: architect`; optional for `actor: worker` | Session id; **required** on architect rows; merge policy validates provenance |
| `adjudication_provenance_token` | yes when `actor: architect` | Pack-issued token bound to `adjudication_id`; merge policy validates |
| `recorded_at_utc` | yes | ISO-8601 UTC |

Journal supports false-merge audit and marker-list recalibration without mutating historical rows.

### Architect adjudication surface

Must not require the operator **within the architect autonomy budget below**.

- **Inbox:** durable pack-owned pending queue (operator state path) listing `PENDING_ARCHITECT` items with finding text excerpt, **`normalized_text_hash`**, marker hits, PR/head, appeal reason when present, and stable `adjudication_id`.
- **Delivery:** gate appends to inbox on ambiguity/appeal; architect session discovers pending items via a sanctioned read command or documented inbox path (planner implements).
- **Consumption:** architect records verdict (`BLOCK` or `DEFER`) via a **sanctioned architect-only** write command (not invocable from worker/AO planner sessions) that appends journal row (`actor: architect`, **`actor_session` required**, plus pack-issued **`adjudication_provenance_token`** bound to the inbox item). Write **must** validate inbox `normalized_text_hash` against the live finding text; stale hash rejects adjudication and forces re-gate. Merge policy **rejects** architect adjudication rows missing valid provenance or with stale text hash. Command updates inbox item status and re-evaluates aggregate PR outcome. Architect verdict is **final** for that finding on that head unless the finding text changes (new head → re-gate).
- **Provenance token storage:** `adjudication_provenance_token` is issued only to the architect-session write path; it is **not** copied into worker-visible inbox payloads, finding-delivery messages, or AO session transcripts. Inbox rows expose `adjudication_id` only; token is validated server-side on write. Worker-readable surfaces must not contain replayable tokens.
- **Authorization boundary (observable):** adjudication write entry point rejects invocations when `AO_SESSION_KIND` (or equivalent pack session classifier) is `worker` / `orchestrator-planner`; token material is stored in architect-only state (file mode + path ACL). Fixture must prove worker-class invocation cannot obtain token or succeed on write.
- **Architect autonomy budget (OPERATOR DECISION 2026-07-07): 2 permissive verdicts, then call the operator.** A **permissive** adjudication is an architect verdict that keeps a PR on the merge path (ambiguity resolved to `DEFER`, or a worker appeal overturning a `BLOCK`). A global counter of permissive architect adjudications (journal-derived, not a new mutable store of truth) increments on each such verdict; when it reaches **2**, the next pending item enters `PENDING_OPERATOR`: the operator is notified via an observable surface (planner picks the mechanism), no auto-merge occurs for items pending operator review, and only an operator-recorded acknowledgment (journaled, `actor: operator`) resets the counter and returns adjudication authority to the architect. Restrictive verdicts (`BLOCK`) do not consume the budget. This is the sole operator touchpoint and it bounds — it does not replace — architect adjudication.
- **Forbidden:** routing adjudication to AO orchestrator LLM-turn; silent timeout that auto-DEFERs; operator-required UI; worker-readable provenance tokens.

### Merge policy hook (not a merge executor)

Expose a read-only policy helper consumed by merge-with-local-adoption and autonomous merge guards:

- **Allow merge** when current head has `clean_early_stop` (draft 221 — no triage hashes required) **or** `merge_triage_cleared` for matching `(pr_number, head_sha)` with live `open_findings_snapshot_hash` and `marker_list_hash` equal to the clearance terminal.
- **Deny merge** when `at_cap_open_findings` exists without clearance; when any `PENDING_ARCHITECT` remains; when aggregate gate outcome is `BLOCK` without architect overturn.
- Align with `prompts/agent_rules.md` self-merge prohibitions — this gate is **policy input only**.

### Fail-closed lineage (#188 principle — cited)

- Marker list file missing or invalid JSON → gate exits non-zero; merge-eligibility not promoted.
- #611 reader or finding store unavailable → gate exits non-zero; no silent DEFER-all fallback.
- Catalog or journal append failure → gate exits non-zero; clearance terminal not emitted.
- The gate **never passes by failing to parse** (same principle as shipped finding-ledger guard in draft 188).

### Architecture sketch

```
at_cap_open_findings (draft 221)
        |
        v
+----------------------------+
|  Merge triage gate         |
|  (deterministic markers)   |
+----------------------------+
        |
        +-- BLOCK --------> worker delivery (bounded) --+--> appeal? --+
        |                                                |             |
        +-- DEFER -------+                               v             v
        |                |                          architect      journal
        +-- PENDING -----+--> adjudication inbox ----> verdict ------>+
        |   (ambiguity/      (architect session)                      |
        |    appeal)                                                  v
        v                                                    aggregate outcome
  all DEFER + catalog OK
        |
        v
merge_triage_cleared  ---> merge policy hook ---> merge-with-local-adoption
        |
        v
deferred-findings catalog (fingerprint-deduped, per-PR)
```

### Design options (pre-draft — recorded)

| Option | Verdict |
| --- | --- |
| A. LLM re-reads code at cap to re-judge severity | **Rejected** — operator forbids; non-deterministic; duplicates reviewer |
| B. Deterministic marker gate + catalog + architect inbox (this draft) | **Land** — matches audit §4b and operator decisions |
| C. Auto-create GitHub issues for every deferred finding | **Rejected** — operator decision 2026-07-07 |
| D. Operator manual triage UI | **Rejected** — operator not required; architect owns ambiguity |

### Full-class scenario enumeration (fix the class, not the case)

| Dimension | Values | Expected class outcome |
| --- | --- | --- |
| Marker match | BLOCK-only / DEFER-only / both / neither | `BLOCK` / `DEFER` / `PENDING_ARCHITECT` / `PENDING_ARCHITECT` |
| Finding mix | all DEFER / mixed BLOCK+DEFER / all BLOCK | eligible after catalog / blocked + partial worker send / blocked continuation |
| Text drift | finding edited between cap and gate / superseded run | gate uses current open finding text on terminal head; journal records head_sha |
| Language | non-English / reworded without markers | `PENDING_ARCHITECT` unless markers still hit |
| Infra | catalog write fail / journal fail / inbox unavailable | fail-closed; no clearance |
| Lifecycle | pending verdict process crash / restart | inbox + journal durable; gate re-run idempotent; still blocked until architect verdict |
| Dedup | same fingerprint on two PRs | separate catalog rows per PR; dedup within PR head history |
| Appeal timing | appeal after BLOCK send / appeal after architect DEFER | fail-closed until architect rules; no retroactive merge without clearance |
| Severity label | blocking label with DEFER markers / non-blocking with BLOCK markers | text rule wins for merge policy |
| Clean path | `clean_early_stop` on head | gate not invoked (draft 221) |

```contract-evidence
binding-id: orchestrator-pack:merge-triage:gate-trigger-at-cap
binding-type: cli-behavior
binding: merge triage entry requires latched at_cap_open_findings for PR
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: gate trigger guard
expected: skip without latched terminal

binding-id: orchestrator-pack:merge-triage:marker-classification
binding-type: cli-behavior
binding: deterministic marker classifier maps audit seed fixtures to BLOCK DEFER or PENDING_ARCHITECT
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: marker classifier
expected: matrix verdicts

binding-id: orchestrator-pack:merge-triage:ambiguity-fail-closed
binding-type: cli-behavior
binding: both-list and neither-list findings become PENDING_ARCHITECT without clearance
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
selector: ambiguity classifier
expected: pending architect blocked

binding-id: orchestrator-pack:merge-triage:catalog-durability
binding-type: cli-behavior
binding: deferred catalog fingerprint dedup per pr_number and aborts clearance on write failure
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: deferred catalog writer
expected: deduped rows fail-closed

binding-id: orchestrator-pack:merge-triage:clearance-terminal
binding-type: cli-behavior
binding: all-DEFER run emits merge_triage_cleared with open_findings_snapshot_hash and marker_list_hash
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
selector: clearance terminal
expected: merge_triage_cleared fields present

binding-id: orchestrator-pack:merge-triage:merge-policy-hook
binding-type: cli-behavior
binding: merge policy allows clean_early_stop or validated merge_triage_cleared; denies at_cap without clearance
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)
selector: merge policy helper
expected: allow deny matrix

binding-id: orchestrator-pack:merge-triage:architect-adjudication
binding-type: cli-behavior
binding: architect adjudication requires provenance token and normalized_text_hash validation
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
selector: architect adjudication write
expected: provenance and stale-text rejection

binding-id: orchestrator-pack:merge-triage:block-bounded-continuation
binding-type: cli-behavior
binding: BLOCK aggregate delivers only blocking findings without cap budget increment
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)
selector: block delivery path
expected: single finding no clearance

binding-id: orchestrator-pack:merge-triage:remediation-new-head
binding-type: cli-behavior
binding: latched at-cap gate re-runs on advanced head after BLOCK remediation
producer: orchestrator-pack
evidence: NEW(produced-by AC#14)
selector: post-cap remediation
expected: clearance when open set empty
```

## Files in scope

- Shared merge-triage gate module under `scripts/**` (new) — classifier, aggregate outcome, policy helper
- Marker list seed file under `scripts/**` or `docs/**` (new, versioned)
- Deferred-findings catalog library (new, pack-owned state IO)
- Verdict journal library (new, append-only)
- Architect adjudication inbox + read/write commands (new)
- Integration hook consumed by merge-with-local-adoption guard path (update existing merge guard / checklist script — planner picks entry point)
- Finding-delivery integration for BLOCK-only continuation (update existing send/reconcile script — planner picks)
- `tests/**` and `tests/external-output-references/**` (new fixtures per scenario matrix)
- Static guards (new, planner names) — marker-list presence, no dead `ao review list` on gate path, fail-closed fixtures
- `prompts/agent_rules.md` (update) — document merge-eligibility policy input if not already explicit

## Files out of scope

- Per-tier cap counting / early-stop — draft 221
- Same-(PR,sha) dedup — brief C
- Auto-promotion of catalog entries to GitHub issues
- Reviewer prompt / finding-bar changes (#51)
- Re-labeling severities in the finding store
- AO 0.10 #611 reader implementation (consume only)
- `vendor/**`, live `agent-orchestrator.yaml`, AO core packages
- Merge execution itself (merge-with-local-adoption remains the executor)

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
tests/external-output-references/**
docs/**
prompts/**
```

## Acceptance criteria

1. **Gate trigger guard.** Static guard or unit test proves triage entry points require a persisted `at_cap_open_findings` record for the PR/head and do not run on `clean_early_stop` or in-progress cycles alone.

```positive-outcome
asserts: merge triage entry point returns classified skip without at_cap_open_findings fixture present
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: gate-trigger-at-cap
proof-command: npx vitest run -t "gate-trigger-at-cap"
```
2. **Marker classification matrix.** Fixtures prove each operator seed marker hits the expected verdict in isolation, including prefix markers with trailing `…`; `parser error` → `BLOCK`; `CI will fail unless` (conditional qualifier vetoes BLOCK) → `DEFER`; `every` + `classified malformed` in order (internal ellipsis marker) → `BLOCK`; `TOCTOU` → `DEFER`; `if the process crashes between` (prefix of `if the process crashes between…`) → `DEFER`; `verify.ps1 fails` → `BLOCK`; `[scope-violation]` declaration-class in title/body → `DEFER`; scope-violation citing `vendor/**` → `BLOCK`; `written to disk` → `BLOCK`; `when bwrap/unshare is unavailable` (prefix) → `DEFER`.

```positive-outcome
asserts: classifier maps verbatim audit marker fixtures to BLOCK or DEFER per binding surface table
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: marker-classification
proof-command: npx vitest run -t "marker-classification"
```
3. **Ambiguity fail-closed.** Fixture with both BLOCK and DEFER markers (or neither) yields `PENDING_ARCHITECT`, creates inbox row, journals event, and merge policy denies clearance.

```positive-outcome
asserts: both-list and neither-list fixtures produce PENDING_ARCHITECT and non-zero blocked merge policy
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: ambiguity-fail-closed
proof-command: npx vitest run -t "ambiguity-fail-closed"
```
4. **Deferred catalog durability.** On all-DEFER aggregate, gate appends one catalog row per open finding, dedups by `fingerprint` on re-run, groups under `pr_number`, and aborts clearance when catalog write fails (fixture simulates IO error).

```positive-outcome
asserts: catalog contains fingerprint-deduped rows per PR and failed write prevents merge_triage_cleared emission
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: catalog-durability
proof-command: npx vitest run -t "catalog-durability"
```
5. **Clearance terminal.** When all findings DEFER and catalog write succeeds, gate emits `merge_triage_cleared` linked to source `at_cap_open_findings` and current `head_sha`; fixture validates required fields.

```positive-outcome
asserts: merge_triage_cleared record emitted with pr_number head_sha source_terminal_ref open_findings_snapshot_hash
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: clearance-terminal
proof-command: npx vitest run -t "clearance-terminal"
```
6. **Merge policy hook.** Helper returns deny for `at_cap_open_findings` without clearance. **Clean path:** allow on `clean_early_stop` for matching head without triage clearance fields. **At-cap cleared path:** allow on `merge_triage_cleared` only when live `open_findings_snapshot_hash` and `marker_list_hash` match clearance record; deny on finding or marker-list drift (AC#13). Deny when any inbox item remains `pending`; deny architect journal rows without valid `adjudication_provenance_token`.

```positive-outcome
asserts: merge policy helper allow/deny matrix matches draft 221 and triage terminals on fixtures
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: merge-policy-hook
proof-command: npx vitest run -t "merge-policy-hook"
```
7. **Architect adjudication path.** Fixture: worker appeal on BLOCK → inbox pending with `normalized_text_hash` → architect DEFER verdict with required `actor_session` + provenance token → catalog row written → clearance emitted; stale finding text rejects adjudication write; architect BLOCK verdict → merge stays denied; forged worker attempt to write `actor: architect` row is rejected; worker-class session invocation of adjudication write exits non-zero without token access; journal contains both gate and architect rows with distinct `actor` values. Surface is consumable without operator action (documented read/write commands or inbox path).

```positive-outcome
asserts: appeal and architect verdict fixtures transition aggregate outcome only through journaled architect actor
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: architect-adjudication
proof-command: npx vitest run -t "architect-adjudication"
```
8. **BLOCK bounded continuation.** Fixture: single BLOCK + DEFER mix delivers only BLOCK finding to worker channel; distinct-head budget not incremented (draft 221 latch unchanged); auto review start remains suppressed.

```positive-outcome
asserts: BLOCK-only delivery fixture sends one finding and does not emit merge_triage_cleared
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: block-bounded-continuation
proof-command: npx vitest run -t "block-bounded-continuation"
```
9. **Crash/restart idempotency.** Fixture: gate re-run after partial journal write or process exit before clearance does not duplicate catalog rows for same fingerprint and does not auto-merge while architect pending.

```positive-outcome
asserts: idempotent re-gate fixture preserves single catalog row per fingerprint and blocked state across restart
input: realistic
```

10. **Cross-PR fingerprint collision.** Same fingerprint on two PRs yields two catalog rows (distinct `pr_number`); dedup remains per PR.

```positive-outcome
asserts: two PR fixtures with same fingerprint produce two catalog rows not merged across PRs
input: realistic
```

11. **Fail-closed parse.** Missing marker file, malformed marker JSON, empty finding text (classified `PENDING_ARCHITECT` **and** gate exits non-zero), and #611 reader failure each exit non-zero and do not emit clearance (draft 188 principle).

```positive-outcome
asserts: fail-closed fixtures exit non-zero without merge_triage_cleared for marker parse and reader failures
input: realistic
```

12. **Non-English / reworded text.** Fixture with no marker substring hits `PENDING_ARCHITECT` even when severity is blocking.

```positive-outcome
asserts: reworded-no-marker fixture yields PENDING_ARCHITECT not DEFER
input: realistic
```

13. **Finding text superseded between cap and gate.** Fixture: open finding body changes on same head before gate re-run; classifier uses latest text; journal records `head_sha` and `gate_run_id`.

```positive-outcome
asserts: superseded-text fixture classifies against latest open finding body on terminal head
input: realistic
```

14. **BLOCK remediation new head.** Fixture: at_cap latched → BLOCK worker fix → new head with zero open findings → gate re-run emits clearance without cap budget increment; new head with remaining findings → re-classify.

```positive-outcome
asserts: new head after BLOCK remediation triggers gate re-run and clearance when open set empty without distinct-head budget increment
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: merge-triage
expected: remediation-new-head
proof-command: npx vitest run -t "remediation-new-head"
```
## Upgrade-safety check

- Gate, catalog, journal, and inbox state live under pack-owned operator paths — no `ao.db` schema coupling; survive AO 0.10.x upgrades.
- Marker list is versioned file — recalibration does not require code deploy when format supports hot reload; otherwise bump seed version in pack.
- Gate consumes #611 reader abstraction — dead AO 0.9 CLI verbs not introduced.
- Merge policy hook is advisory input — merge-with-local-adoption remains operator-controlled executor.

## Verification

1. `npx vitest run` for merge-triage classifier, catalog, journal, inbox, and policy-helper tests (AC#1–13).
2. `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1`.
3. Static guard: gate path uses #611 reader / pack finding store; no dead `ao review list` on triage path (AC#1).
4. Static guard: verbatim BLOCK/DEFER seed markers present in versioned marker file (AC#2).
5. Replay fixture: `at_cap_open_findings` → gate → `merge_triage_cleared` golden trace validates field presence for brief package integration with draft 221.
6. Fixture: BLOCK remediation new-head path (AC#14).

## Decisions

- **Prior art:** extends #51 finding vocabulary and #188 fail-closed guard lineage; consumes draft 221 terminal; does not duplicate cap logic (brief A) or dedup (brief C).
- **Land option B** (deterministic markers + catalog + architect inbox). Rejected LLM re-triage and auto-issue backlog (operator 2026-07-07).
- **BLOCK continuation:** worker receives BLOCK findings only; cap budget not incremented; appeal routes to architect (not operator).
- **Architect surface:** pack-owned inbox + sanctioned read/write commands; AO orchestrator LLM-turn explicitly forbidden for adjudication.
- **Merge executor:** unchanged — merge-with-local-adoption reads policy helper only.
- **Evidence base:** `docs/investigations/review-criticality-cycle-cap-audit-2026-07-02.md` §2/§4b; operator decisions quoted in Binding surface.
- **Scope-violation / conditional trust-boundary DEFER markers:** operator binding (audit §4b, 2026-07-07) — `[scope-violation]` / `category: scope-violation` / conditional attacker-spoof text → gate verdict `DEFER` (catalog debt, not declaration waiver). #51 review-path materiality unchanged; open finding may remain until worker/declaration fix — merge eligibility only via clearance terminal with snapshot + marker hashes. Codex pass-01/02 scope-violation challenges **rejected** as operator relitigation.
- **Architect provenance:** adjudication write requires architect-only command + provenance token (pass-02 security finding).
- **Marker-list drift:** clearance records marker version/hash; drift before merge invalidates clearance (pass-02 spec finding).
- **Clearance snapshot hash:** added per pass-01 spec finding — stale same-head clearance invalidated on finding-set or text drift.