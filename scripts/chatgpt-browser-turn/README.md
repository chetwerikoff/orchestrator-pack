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

Quarantine does not unblock the profile. It creates a blocking tombstone and preserves the original bytes. Final adjudication requires an operator-supplied evidence file and its expected SHA-256:

```bash
npm run chatgpt-browser-turn -- clear \
  --profile <path> --cdp <url> \
  --identity <tombstone-identity> --generation <n> --adjudicate \
  --adjudication-evidence-file /absolute/path/to/evidence \
  --expected-adjudication-sha256 <sha256>
```

A stale generation, changed evidence, live owner, unreadable lock, or publication that cannot be proven uncommitted remains blocked.

## Result and retry rules

`turn` writes exactly one JSON `turn-result/v1` line. `ok` exits 0. Invocation-local validation/send failures use exit family 10, exact recovery/conversation ambiguity 11, profile walls/busy/orphan state 12, machine/driver failure 13, and incompatible durable state 14.

`status/list`, `clear`, and `capability` write `control-result/v1`. `publication-status` writes `publication-status/v1`. These envelopes are body-free: they may contain identifiers, paths, generations, hashes, byte lengths, timestamps, and causes, but never prompt or reply bodies.

Never resend after possible delivery merely because the caller missed the terminal result. Query `publication-status` and `status/list` first. Possible-delivery incidents are not timer-cleared or stale-lock reclaimed.

## Parallel admission

Parallel operation is fail-closed. Without current positive capability evidence bound to the exact candidate digest, build digest, configured profile/CDP digest, and Gate-B digest, the helper serializes at configured-profile scope.

Even with positive capability evidence, every invocation rechecks the current service-issued witness surface before send. Missing or contradictory witness evidence downgrades capability visibly and falls back to exclusive profile execution. Same-conversation turns remain serialized or refused. Causal success requires an exact service-issued submitted user-message ID and assistant-message ID linked as its reply; DOM order/count/timing/text similarity never creates `ok`.

## Publication safety

The helper writes the complete reply to a same-directory `0600` temporary file, `fsync`s it, persists a prepared publication record, and then uses an atomic Linux no-clobber rename primitive with copy fallback disabled. The final inode must match the prepared temp inode before `ok` is possible. The parent directory is then `fsync`ed and the final byte length/SHA-256 are recorded.

A crash after rename but before result emission is recoverable by `publication-status` from the inode witness. A destination that appears before the no-clobber commit remains untouched and yields `recovery_required` with the complete temp retained.

## Gate B and first live use

Deterministic Gate-B coverage is in `scripts/toolchain/chatgpt-browser-turn.test.ts` and is run by the repository Vitest lanes plus:

```bash
npm run test:issue-964
```

Before the first real ChatGPT turn with a newly built candidate, the operator must run a live smoke against the dedicated automation profile and record the exact candidate/build/config/gate digests. The live smoke must demonstrate at least:

1. one existing-chat success with a service-issued user-to-assistant causal witness and byte-verified publication;
2. one fresh-chat success with canonical conversation identity;
3. same-chat overlap serialized/refused without duplicate send;
4. destination collision leaves external bytes untouched and produces the correct pre-send or post-delivery state;
5. `status/list`, exact `clear`, opaque quarantine/tombstone, and `publication-status` remain usable after a forced interrupted run.

Do not mint positive parallel capability evidence from a synthetic test alone. The CLI accepts Gate-B binding only when the live runtime witness is present and the supplied Gate-B digest matches the exact current gate source digest.

## Retained recovery copy and rollback

Before first live use, create a digest-pinned recovery copy outside the working tree containing:

- `scripts/chatgpt-browser-turn.ts`;
- the complete `scripts/chatgpt-browser-turn/` directory;
- `scripts/kernel/subprocess.ts`;
- the Node 22 runtime used for the live candidate, or an operator-recorded reproducible Node 22 installation reference.

Record SHA-256 digests for the retained files and keep that copy until `status/list` returns no unresolved state and every relevant `publication-status` is terminal with no opaque quarantine or blocking tombstone.

On rollback, first quiesce new invocations and stop only exact matching browser-turn processes. Do not delete or timer-clear possible-delivery state. Use the retained digest-pinned copy for `status/list`, `publication-status`, and exact `clear`/adjudication operations until all pre-rollback incidents are resolved. Preserve unreadable records, tombstones, publication receipts, and complete temporary replies until their exact recovery path is finished.
