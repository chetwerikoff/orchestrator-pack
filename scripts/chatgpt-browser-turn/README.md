# ChatGPT browser-turn transport

This directory contains the tracked Node 22 one-shot transport for Issue #964. It drives the operator's already-running, headed, dedicated ChatGPT automation Chrome profile over CDP. It does not launch Chrome, modify prompts, add task policy, or replace `.claude/skills/discuss-with-gpt/driver.mjs`.

Adoption by the authoring skill is intentionally separate and tracked by Issue #971.

## Canonical invocation

Use the repository package entrypoint so the Node-major guard runs first:

```bash
npm run chatgpt-browser-turn -- turn \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --chat-url https://chatgpt.com/c/<conversation-id>
```

Fresh-chat mode uses `--new-chat --project-url <url>` instead of `--chat-url`.

The input file is snapshotted once and sent byte-for-byte as decoded UTF-8 text. The helper rejects empty input, BOM, NUL, invalid UTF-8, bare CR, symlinks, non-regular files, and files that change during the snapshot. It never prepends or appends prompt text.

The output path is reserved before browser interaction. A pre-existing or already-reserved destination is an invocation-local `output_conflict`. After possible delivery, any publication collision is `recovery_required`; the helper never overwrites the foreign destination and preserves its complete temporary reply for recovery.

## Control plane

All control commands require the same `--profile` and `--cdp`, which derive the configured-profile key.

```bash
npm run chatgpt-browser-turn -- status/list --profile <path> --cdp <url>
npm run chatgpt-browser-turn -- capability --profile <path> --cdp <url>
npm run chatgpt-browser-turn -- publication-status --profile <path> --cdp <url> --invocation <uuid>
```

Readable incidents are cleared only with the exact identity, generation, and evidence token returned by `status/list`:

```bash
npm run chatgpt-browser-turn -- clear \
  --profile <path> --cdp <url> \
  --identity <identity> --generation <n> --evidence-token <sha256>
```

Unknown/incompatible durable bytes block the entire configured profile. They may be moved to opaque quarantine only by exact identity and generation:

```bash
npm run chatgpt-browser-turn -- clear \
  --profile <path> --cdp <url> \
  --identity <opaque-identity> --generation <n> --quarantine
```

Quarantine does not unblock the profile. It creates a blocking tombstone and preserves the original bytes. If the process is interrupted while that tombstone is still `preparing`, `status/list` exposes that blocking tombstone; repeating `clear --quarantine` with its exact current tombstone identity and generation resumes the recorded move instead of creating a second tombstone. Final adjudication requires an operator-supplied evidence file and its expected SHA-256:

```bash
npm run chatgpt-browser-turn -- clear \
  --profile <path> --cdp <url> \
  --identity <tombstone-identity> --generation <n> --adjudicate \
  --adjudication-evidence-file /absolute/path/to/evidence \
  --expected-adjudication-sha256 <sha256>
```

A stale generation, changed evidence, live owner, unreadable lock, or publication that cannot be proven uncommitted remains blocked.


## Proven non-delivery (`dispatch_request_not_observed`)

After the existing 30-second submitted-turn observation window exhausts with no service-proven user id, the helper may return `send_failed` with `cause: dispatch_request_not_observed` and `possibleDelivery: false` only when **all** of the following held from `armDispatch()` through that exhaustion:

- configured-context HTTP observation and target-complete outbound-WebSocket sent-frame observation were established before dispatch and remained gap-free;
- zero outbound HTTP(S) requests on the context boundary;
- zero outbound WebSocket frames on covered targets;
- no new user DOM nodes beyond the pre-dispatch baseline;
- for `--new-chat`, the normalized page URL stayed unchanged.

Any post-arm outbound HTTP request, WebSocket frame, DOM user node, fresh-chat URL transition, or boundary-coverage loss keeps the existing `submitted_turn_id_unproven` possible-delivery path. Pre-dispatch observer establishment failure performs zero send and returns `driver_error` / `driver_exception_before_send`.

Proven non-delivery reuses the existing non-possible-delivery cleanup path: close an invocation-owned page, delete only this invocation's incident, and release schedule/destination locks. A later independent invocation may retry normally.

### Gate-B live characterization (Half A)

On the supported Chromium/Playwright runtime, operators should verify the production path can observe:

1. **service-worker-owned HTTP** on the configured `BrowserContext` request surface; and
2. **worker/secondary-target outbound WebSocket sends** via target auto-attach and `Network.webSocketFrameSent`.

If either live boundary probe is unavailable or unproven, the helper keeps possible-delivery behavior and does not mint proven non-delivery.

Operator probe entrypoint: `runGateBCharacterization` in `scripts/chatgpt-browser-turn/dispatch-observation.ts`. Run it against the live automation profile before relying on proven non-delivery in production.

## Result and retry rules

`turn` writes exactly one JSON `turn-result/v1` line. `ok` exits 0. Invocation-local validation/send failures use exit family 10, exact recovery/conversation ambiguity 11, profile walls/busy/orphan state 12, machine/driver failure 13, and incompatible durable state 14.

## Page lifetime and process exit

Each `turn` invocation connects to the operator's already-running Chrome over CDP, may create or reuse a ChatGPT tab, and must release what it acquired on every terminal path:

- a page the helper **created** (`owned: true`) is closed before durable incident deletion and lock release on success and on failures that are not possible-delivery;
- a page the helper **reused** (`owned: false`) is never closed;
- a failure after **possible delivery** keeps its page open as operator recovery evidence;
- the CDP client connection is always released in a `finally` block so the one-shot process can exit once the terminal result is emitted.

Releasing the CDP client disconnects Playwright from the operator's Chrome; it does not terminate the browser process. Possible-delivery recovery therefore depends on adopted-context tabs surviving client disconnect — see `fixtures/cdp-page-survival-precondition.md` for the live observation record.

`clear` performs a live profile-wall readiness probe when the target incident is a profile wall; that probe connects over CDP and releases its short-lived connection before returning. `status/list` does not connect to Chrome.

`status/list`, `clear`, and `capability` write `control-result/v1`. `publication-status` writes `publication-status/v1`. These envelopes are body-free: they may contain identifiers, paths, generations, hashes, byte lengths, timestamps, and causes, but never prompt or reply bodies.

Never resend after possible delivery merely because the caller missed the terminal result. Query `publication-status` and `status/list` first. Possible-delivery incidents are not timer-cleared or stale-lock reclaimed.

## Parallel admission

Parallel operation is fail-closed. Without current positive capability evidence bound to the exact candidate digest, build digest, configured profile/CDP digest, browser provenance, and Gate-B digest, the helper serializes at configured-profile scope.

Even with positive capability evidence, every invocation rechecks the current browser provenance and service-issued witness surface before parallel dispatch. Missing or contradictory witness evidence, changed browser provenance, or changed capability binding downgrades capability visibly and falls back to configured-profile serialization or a zero-send profile-scoped refusal. Same-conversation turns remain serialized or refused. Causal success requires an exact service-issued submitted user-message ID and exactly one assistant-message ID linked as its reply; DOM order/count/timing/text similarity never creates `ok`, and ambiguous user or assistant observations fail closed.

## Publication safety

The helper creates a same-directory `0600` temporary file and durably persists a prepared publication record bound to that empty temp inode before writing any reply body bytes. It then writes and `fsync`s the complete reply and uses an atomic Linux no-clobber rename primitive with copy fallback disabled. The final inode must match the prepared temp inode before `ok` is possible. The parent directory is then `fsync`ed and the final byte length/SHA-256 are recorded. A crash after the prepared record but before or during body write therefore leaves a discoverable publication recovery anchor rather than an untracked body-bearing temporary.

A crash after rename but before result emission is recoverable by `publication-status` from the inode witness. A destination that appears before the no-clobber commit remains untouched and yields `recovery_required` with the complete temp retained.

## Gate B and first live use

Deterministic Gate-B coverage is in `scripts/toolchain/chatgpt-browser-turn.test.ts` and the review-regression companion `scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts`; both are run by the repository Vitest lanes plus:

```bash
npm run test:issue-964
```

For the exact candidate/profile/CDP that will be characterized, first query the capability surface and record the emitted `expected_binding` object:

```bash
npm run chatgpt-browser-turn -- capability \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222
```

The `candidate_digest`, `build_digest`, `config_digest`, and `gate_digest` in `expected_binding` are the Gate-B binding for that exact runtime candidate. `candidate_digest` covers the tracked TypeScript transport plus the reused `.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs` verifier; `build_digest` additionally binds the exact Node version, platform, and architecture. `gate_digest` hashes the gate-bound test sources; it is a staleness binding only and is not an operator attestation input.

Run one successful serialized existing-chat characterization turn on the exact profile/CDP. The helper arms parallel eligibility by itself when the turn reaches `ok` with a live witness surface on this binding — no environment variable is required. Each later successful witnessed turn extends the lease in place; continuous successful operation does not expire until idleness exceeds the TTL.

Query `capability` again after characterization and retain its browser provenance, evidence digest, observation/expiry timestamps, and downgrade generation as Gate-C telemetry. If the result is not `state: ok`, parallel smoke is not admitted; fallback remains configured-profile serialization.

## Driver diagnostics

When a `turn` fails with `cause: driver_exception_before_send` or `cause: driver_exception_after_possible_delivery`, or a control command fails with `cause: command_failed`, the helper records a durable `driver-diagnostic/v1` JSON file under the configured-profile state area at `<state-root>/<configured_profile_key>/diagnostics/<identity>.json`. Turn failures key the file by `invocation_id`; control failures without a resolved profile key do not create state (stderr mirroring only when enabled). Each record contains the exception name, message, and stack plus `configured_profile_key`, `cause`, and `created_at`. Records may contain exception text and stay local to the operator machine; they are not emitted on stdout.

The emitted `turn-result/v1` or `control-result/v1` may include `driver_diagnostic_id`, an identifier only, pointing at that record. Envelopes remain body-free: no prompt text, reply text, or exception text on stdout.

Set `CHATGPT_BROWSER_TURN_DEBUG=1` to mirror the same diagnostic JSON line to stderr. With the variable unset, stdout and stderr match prior behavior byte-for-byte aside from the optional new result identifier field on stdout.

Before the first real ChatGPT turn with a newly built candidate, the operator must run a live smoke against the dedicated automation profile. The live smoke must demonstrate at least:

1. one existing-chat success with a service-issued user-to-assistant causal witness and byte-verified publication;
2. one fresh-chat success with canonical conversation identity;
3. same-chat overlap serialized/refused without duplicate send;
4. destination collision leaves external bytes untouched and produces the correct pre-send or post-delivery state;
5. `status/list`, exact `clear`, opaque quarantine/tombstone, and `publication-status` remain usable after a forced interrupted run.

Do not mint positive parallel capability evidence from a synthetic test alone. Parallel characterization proceeds only after the serialized live success above, and every parallel invocation must independently retain current witness availability, browser provenance, and exact capability binding until dispatch.

## Retained recovery copy and rollback

Before first live use, choose and record an absolute recovery root outside the working tree. The canonical operator-local layout is the resolved home directory plus `.local/lib/orchestrator-pack/chatgpt-browser-turn-recovery/<candidate_digest>`; for example:

```bash
RECOVERY_ROOT="$(realpath "$HOME")/.local/lib/orchestrator-pack/chatgpt-browser-turn-recovery/<candidate_digest>"
printf '%s\n' "$RECOVERY_ROOT"
```

Record the printed absolute path alongside the live characterization evidence. Preserve the same relative layout under that root and include:

- `scripts/chatgpt-browser-turn.ts`;
- the complete `scripts/chatgpt-browser-turn/` directory;
- `scripts/kernel/subprocess.ts`;
- `.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs`;
- the exact Node 22 runtime used for the live candidate, or an operator-recorded reproducible installation reference;
- the Playwright/Playwright-core package location and version used by `loadChromium`, or an operator-recorded reproducible installation reference for that exact compatible package.

The verifier bytes are part of `candidate_digest`; changing them invalidates prior positive capability evidence. The external Playwright installation is not stored in helper state, so its resolved package location/version must be retained as operator evidence before live use. `status/list` and publication recovery remain browser-independent, but clearing a profile wall performs a live profile/UI readiness probe and therefore requires the verifier plus a compatible Playwright runtime.

Record SHA-256 digests for every retained first-party file and keep the recovery copy and runtime references until `status/list` returns no unresolved state and every relevant `publication-status` is terminal with no opaque quarantine or blocking tombstone.

On rollback, first quiesce new invocations and stop only exact matching browser-turn processes. Do not delete or timer-clear possible-delivery state. Use the retained digest-pinned copy for `status/list`, `publication-status`, and exact `clear`/adjudication operations until all pre-rollback incidents are resolved. Preserve unreadable records, tombstones, publication receipts, and complete temporary replies until their exact recovery path is finished.
