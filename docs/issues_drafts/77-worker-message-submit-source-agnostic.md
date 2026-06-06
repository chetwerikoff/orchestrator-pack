# Submitting a delivered worker message must be source-agnostic, not per-sender

GitHub Issue: #232

## Prerequisite

- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) — **hard
  prerequisite** (already shipped and live): any always-on submit reconciler MUST run as a
  supervised child of that registry, never as a new unsupervised process. If the design instead
  extends an existing supervised child (no new process), state that explicitly; either way the
  mechanism's liveness is owned by #205, not invented here.
- Context (the narrow precedent this generalizes): GitHub #216 added a submit step
  (`scripts/lib/Submit-WorkerInputDraft.ps1`, called only from
  `scripts/review-finding-delivery-confirm.ps1`) that presses Enter for a **review-finding**
  delivery. It is the only sender path that re-submits today.
- Context (other senders that hit the same delivery primitive but do **not** re-submit):
  GitHub #191 (`scripts/ci-green-wake-reconcile.ps1`) and GitHub #202
  (`scripts/review-send-reconcile.ps1`).

## Goal

A message that AO has **delivered into a worker's input** must end up **submitted** (consumed
by the agent), regardless of which sender produced it — a script nudge, the LLM orchestrator's
own `ao send`, or a first review-finding delivery (spawn-time prompt delivery is named out of
scope below). Today the submit step
exists only on the review-finding path, so every other long or multi-line delivery lands as a
`[Pasted text]` draft that sits unsubmitted until a human presses Enter.

```behavior-kind
action-producing
```

## Binding surface

**External mechanism (not changed here).** On AO 0.9.2 every message to a managed session goes
through `sessionManager.send` → the tmux runtime's `sendMessage`: for input that is multi-line
**or** longer than 200 characters it is delivered as a bracketed paste, followed by exactly
**one** Enter. That single Enter is absorbed by the bracketed paste, so the message stays an
unsubmitted draft; short single-line messages skip the paste path and their Enter submits.
Delivery confirmation treats any pane-output change (including the visible draft) as
"delivered" and never retries the Enter. The pack cannot change AO core; it can only guarantee
the submit on its own side. Filing an upstream report against AO (so `sessionManager.send`
retries Enter and stops treating a draft as delivery, mirroring its own CLI fallback) is
recommended but this issue does not depend on it.

**What this issue commits the repository to:**

- **A source-agnostic submit guarantee, triggered off AO-recorded delivery — never off pane
  text.** Submit a delivered-but-unconsumed worker message irrespective of which sender
  delivered it. The guarantee is a property of "a message was delivered to a worker", not of any
  one sender script — the worst real offender (the LLM orchestrator typing `ao send <worker>
  <prose>`) is not a pack script and cannot be wrapped at the call site. The trigger MUST be a
  **state-derived signal that AO delivered a message via a path that left a pending, unsubmitted
  input draft, and the agent has not consumed it** — not merely "delivered and unconsumed". AO
  takes the bracketed-paste path (leaving a draft that needs an extra Enter) only for multi-line
  or >200-char messages; a short single-line delivery AO already submits itself. The trigger MUST
  exclude deliveries AO already submitted, so a correctly-submitted short message that is merely
  not-yet-consumed during the processing delay — and any future AO that self-submits — yields a
  **no-op**, never an Enter into an empty or next prompt. The "already-submitted vs pending-draft"
  distinction is derivable from AO's own delivery record (which path the message took, from its
  shape), not from parsing pane-text content. Both a script `ao send` and an LLM-orchestrator `ao send` leave such an AO
  record; **human keystrokes typed directly into a pane do not** — so this signal both covers
  every `ao send` sender and structurally cannot fire on human-composed input. Reading raw pane
  text as the trigger (or to reconstruct message content) is out of bounds.
- **Fail-closed on ambiguity.** When the mechanism cannot positively confirm *both* "AO
  delivered this message" *and* "the agent has not consumed it" (delivery not attributable, agent
  streaming, consumption uncertain, or the next prompt may already be showing), it does nothing
  and records why. A wrong submit (private/partial human input, an empty line, or the next queued
  prompt) is a worse failure than a missed one.
- **Enumerated coverage floor.** The mechanism must cover, at minimum, the pack-reachable hang
  classes below; CI must demonstrate each. Any hang class deliberately left uncovered must be
  named in the draft with a reason, not silently dropped:
  - long (>200 char) script nudge to a worker (e.g. the ci-green-wake nudge);
  - **multi-line but short** (<200 chars with a newline) delivery — takes the paste path on the
    newline alone, a class easy to miss if the trigger keys only on length;
  - a borderline-length message pushed over 200 chars by AO's `[from <session>]` sender prefix;
  - the first review-finding delivery before the existing confirm path re-submits it;
  - a restore/retry re-send of a long message;
  - the LLM-orchestrator-composed `ao send` to a worker (the originating incident).
- **Idempotent and side-effect-safe.** Must not double-submit, must not submit a half-rendered
  paste, must not press Enter while the agent is actively streaming or while a human is
  composing, and must not fire repeatedly for the same delivered message. Bound the number of
  submit attempts per delivered message.
- **Capture-anchored signal — no phantom state.** The delivery and consumption signals the
  trigger relies on MUST be anchored to **real captured AO 0.9.2 output** (per the #223/#76
  golden-sample field-shape discipline), not to an assumed shape. In particular the consumption
  signal MUST be distinct from AO's known-broken "any pane-output change counts as delivered"
  heuristic — a visible `[Pasted text]` draft must read as *unconsumed*, not consumed. The
  planner identifies and captures the actual observable; the spec does not pin field names.
- **No silent hang on any branch — escalation is the guarantee.** Bounded attempts are a safety
  cap, not the promise, and fail-closed must not become a permanent silent no-op. A single
  bounded budget (ticks or elapsed time) applies **per AO delivery record across every
  non-terminal branch**: whether submit attempts were exhausted while still unconsumed (Enter
  sent too early, tmux dropped input, target briefly unaddressable) **or** observation stayed
  persistently ambiguous so no attempt was ever made (degraded/stale AO state, consumption never
  positively confirmable). On budget exhaustion the mechanism enters an explicit terminal state
  that **escalates** with operator-visible diagnosis — an audit-log no-op is not escalation.
  Mirrors #171 where escalation, not endless re-delivery, is the guarantee.
- **Split-brain safe.** Observe and submit only; never spawn, kill, `--claim-pr`, or send new
  content. Acts only on the live, intended recipient session; fail-closed (do nothing) when the
  target session is ambiguous, not alive, or not addressable.
- **Multiple pending deliveries to one worker are serialized or fail closed.** Because every AO
  send first clears the input (`C-u`/`Escape`), a second delivery to the same pane **overwrites**
  an earlier still-unsubmitted draft — leaving two unconsumed delivery records but one live input
  buffer holding only the latest. The arbiter MUST NOT blindly press Enter per record: it must
  map the single live buffer to a specific pending record (the surviving/newest one) and submit
  that at most once, and it must NOT press Enter for a stale record whose draft was overwritten
  (that content is gone) — those overwritten records escalate (lost-delivery diagnosis), never a
  blind Enter into an empty or next prompt. When the mapping is ambiguous, fail closed.
- **Exactly one submit owner (supersedes #216's presser).** There must be a single arbiter that
  presses Enter for delivered worker messages; the review-finding submit step (#216) is folded
  into it, not left running in parallel. Two mechanisms observing the same unconsumed message and
  both pressing Enter — or one pressing after the message was already consumed and a new prompt is
  showing — is the failure this forbids. Exclusivity is enforced by a durable per-message submit
  claim / idempotency key, not by timing. The #216 guarantee (a review finding reaches the
  worker) must still hold under the unified owner.
- **Observable.** Each submit (and each deliberate no-op with its reason) is recorded so an
  operator can audit why a message was or was not submitted, without pane scraping in logs.

**Operator adoption.** If this introduces a new always-on reconciler, it must register with the
#205 supervisor and the operator must merge the updated `agent-orchestrator.yaml.example`
process list and restart the supervisor (`ao stop` / `ao start` per that runbook). State the
exact steps in the draft's runbook section. If instead it extends an existing supervised child,
say so and state that no new process is added.

## Files in scope

- Orchestrator side-process / reconciler scripts and their libraries under `scripts/`
  (the submit reconciler and any shared submit helper), marked `(new)` where new.
- Wiring into the #205 supervisor registry and, if a new operator process is introduced, the
  process list in `agent-orchestrator.yaml.example`.
- Tests and fixtures under `scripts/` for the coverage floor and the idempotency/safety cases.
- A runbook / migration note documenting the operator adoption and the audit signal.

## Files out of scope

- `packages/core/**`, `vendor/**`, and any AO CLI behavior — the mechanism observes AO/tmux
  output and presses Enter; it never changes how AO delivers messages.
- Product review-trigger / review-run logic (#163/#207) and the finding-routing scorers
  (#139/#141/#142).
- The upstream AO-core delivery fix itself (external; recommended separately, see Binding surface).
- **Spawn-time post-launch prompt delivery** (`session-manager.js` post-launch `sendMessage`,
  used by agents whose plugin sets `promptDelivery: "post-launch"` — e.g. grok). Named out of
  scope, not silently dropped: the pack's current workers (Cursor / Claude Code / Codex) receive
  their initial prompt at launch (CLI arg / file), not via this paste path, so it is not a
  live hang class today. If the AO-delivery-triggered signal happens to cover it, that is a free
  bonus, not a required coverage-floor item; adopting a post-launch-delivery agent reopens it as
  a separate follow-up.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Source-agnostic submit, scoped to pending-draft deliveries.** A message AO delivered via the
   pending-draft (bracketed-paste) path and the agent has not consumed is submitted regardless of
   which sender delivered it — including a delivery the mechanism did not originate (e.g. an
   LLM-orchestrator `ao send`). The trigger is AO-recorded delivery state, provable on a captured
   AO-state fixture; it does not depend on the mechanism being the sender, and it does not parse
   pane text to decide. A delivery AO already submitted (short single-line, or a self-submitting
   future AO) is a no-op even while not-yet-consumed.
2. **Coverage floor demonstrated.** Each enumerated hang class in Binding surface is exercised
   by a test that fails before the fix and passes after: long script nudge; multi-line short;
   borderline-length crossing 200 via the sender prefix; first finding delivery; restore/retry
   re-send; orchestrator-composed send.
3. **Human input is never submitted.** Direct human keystrokes in a worker pane carry no AO
   delivery record and MUST never trigger a submit; demonstrated by a state in which pane content
   exists with no corresponding AO dispatch.
4. **No double-submit / no premature submit, under concurrency and delay.** A message already
   consumed, currently streaming, or with a possibly-showing next prompt is not (re-)submitted; a
   delivered message is submitted at most the bounded attempt count even across concurrent ticks
   and delayed consumption (the agent consumes seconds after the first Enter). All demonstrated,
   including a test where a fast first Enter must not cause a second Enter to submit the next
   prompt.
5. **Exactly one submit owner.** A single arbiter presses Enter; the #216 path is folded in, not
   run in parallel. A review finding is submitted once total (never by two mechanisms), enforced
   by a durable per-message claim rather than timing; the #216 guarantee still holds. Provable by
   a concurrent-observer test asserting a single submit.
6. **Split-brain safe and fail-closed.** On an ambiguous, dead, or unaddressable target the
   mechanism does nothing and records why; it never spawns, kills, claims, or sends new content.
7. **Auditable.** Every submit and every deliberate no-op is recorded with a reason, derivable
   from state rather than from scraping pane text in logs.
8. **Capture-anchored, with negative states proven.** The delivery and consumption signals are
   anchored to real captured AO 0.9.2 output; negative captured fixtures each produce the correct
   submit/no-op decision: delivered-but-draft (submit), consumed (no-op), streaming (no-op),
   next-prompt/stale-dispatch (no-op), and **short single-line already-submitted (no-op)**. A
   visible `[Pasted text]` draft reads as unconsumed (submit-eligible); an already-submitted
   delivery never triggers an Enter. (The self-submitting-future-AO no-op is a version-skew
   property under Upgrade-safety, proven by a constructed state — AO 0.9.2 cannot emit it, so it
   is not a 0.9.2 capture fixture.)
9. **Escalation on any stuck branch, not silent abandonment.** A delivered message that is never
   submitted within its bounded budget reaches an explicit terminal state that escalates with
   operator-visible diagnosis — on **both** branches: (a) submit attempts exhausted while still
   unconsumed, and (b) observation persistently ambiguous so no attempt was ever made. Provable
   by two tests: first attempt yields no consumption → bounded retry → escalate; and a
   persistently-ambiguous / stale-observer state that never reaches an attempt → escalate. It
   never silently stops at an audit-log no-op.
10. **Multiple pending deliveries to one worker.** With two unconsumed pending-draft records for
    one live worker (the earlier draft overwritten by the later send's input-clear), the arbiter
    submits the single live buffer at most once mapped to the surviving record, never presses
    Enter for the overwritten record (it escalates as lost-delivery), and fails closed on an
    ambiguous mapping. Demonstrated by a two-pending-delivery test.
11. **Supervised.** The mechanism runs under the #205 supervisor (new registered child or an
    extended existing one); it is not a new unsupervised process.
12. **Operator adoption documented and verifiable.** If a new operator-facing process is
    introduced, a runbook / migration note exists and contains the exact post-PR steps (yaml
    merge, supervisor restart, verification); if no new process is added (existing child
    extended), the note states that explicitly. Provable by the note's presence and content.

```positive-outcome
asserts: an AO-delivered, unconsumed worker message (multi-line or >200 chars) is submitted exactly once off AO delivery state and the agent begins consuming it
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no assumption about AO CLI flags beyond reading
  captured session/pane state.
- Version-skew safe: the behavior is confirmed on AO 0.9.2. If a later AO submits reliably on its
  own, the mechanism must be a safe no-op (idempotency / no-premature-submit covers this), not a
  source of double-submits. Because AO 0.9.2 cannot produce a self-submitted long/multi-line
  delivery, this no-op is proven by a constructed state, not a 0.9.2 capture fixture.
- No new repo secrets; any captured pane/state evidence committed as a fixture must be scrubbed of
  tokens/URLs/personal data.
- No new unsupported `agent-orchestrator.yaml` fields; supervisor wiring uses the existing #205
  registry shape.

## Verification

- Criterion 1: a capture-backed AO-delivery-state fixture (delivered, unconsumed) drives a
  submit; assert the submit fires for a delivery the mechanism did not originate, off AO state.
- Criterion 2: one test per enumerated hang class, each red-before / green-after.
- Criterion 3: a fixture with pane content but no AO dispatch record yields no submit.
- Criterion 4: idempotency / concurrency tests — already-consumed, mid-stream, and
  next-prompt-showing states yield no submit; repeated and concurrent ticks on one delivered
  message stay within the bounded attempt count; delayed consumption does not cause a second
  Enter to submit the next prompt.
- Criterion 5: a finding delivery is submitted once total under one arbiter; a concurrent-observer
  test asserts a single submit and the durable claim prevents a second.
- Criterion 6: ambiguous / dead / unaddressable target → no-op with recorded reason; no
  lifecycle side effects.
- Criterion 7: audit records present per submit/no-op, derivable from state.
- Criterion 8: negative captured AO 0.9.2 fixtures (delivered-but-draft → submit; consumed,
  streaming, next-prompt/stale-dispatch, short single-line already-submitted → no-op) each yield
  the correct decision. The self-submitting-future-AO no-op is verified by a constructed state
  (not a 0.9.2 capture), per Upgrade-safety.
- Criterion 9: two cases — (a) a first attempt that does not lead to consumption → bounded retry
  → escalation; (b) a persistently-ambiguous / stale-observer delivery that never reaches an
  attempt → escalation on budget exhaustion. Both with operator-visible diagnosis; no silent stop.
- Criterion 10: a two-pending-delivery-to-one-worker test — single live buffer submitted once for
  the surviving record; the overwritten record escalates (lost-delivery), never a blind Enter;
  ambiguous mapping fails closed.
- Criterion 11: the process appears in the #205 supervisor registry and survives a supervised
  restart.
- Criterion 12: the runbook / migration note exists with the exact operator steps (or states no
  new process is added).
- `pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict` (or the staged-only CI
  equivalent) passes on the change.
