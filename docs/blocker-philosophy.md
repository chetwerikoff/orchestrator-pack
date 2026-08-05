# Operator decree: blocker philosophy and plan-first execution

The following additive rules govern how workers handle execution blockers. They
do not authorize prohibited actions or weaken the repository's existing scope,
safety, review, or merge requirements.

1. **Blockers are warnings.** A condition that appears to block progress is
treated as a warning: the worker checks it, fixes it or completes the
missing prerequisite when possible, and continues with the task. A worker
stops without continuing only when an explicit blocker applies under rule 3.
2. **Plan-first execution.** Before executing a task, the worker writes an
implementation plan and proceeds through that plan without stopping for
intermediate uncertainty. Any deviation from the plan is recorded in the
worker report.
3. **Only explicit blockers; operator lift is absolute within these boundaries.** A
blocker exists only when the operator or the task directive says that it is a
blocker. An explicit operator authorization lifts that blocker unconditionally
for the authorized action; after the authorization, the worker continues without
re-litigating the same blocker.
4. **Gate input only.** Operator lift acts only through the documented operator
input of the specific gate. It never permits fabricating or altering evidence
that the gate checks. Forbidden examples include hand-writing `turn-result`
`state:ok`, editing binding cache, or setting `OPK_VITEST_HARNESS=1`; that
variable substitutes fixtures for live checks and does not lift binding.
5. **No input means terminal.** If gate X has no documented operator input, that
is a legal terminal state, not an invitation to bypass the gate.
6. **Exact target only.** The lift is bound to the exact target, either PR plus
head or Issue plus revision; it does not apply to another target.
7. **Worker work only.** Fix-and-continue applies to the worker's own incomplete
work, never to gate evidence.
