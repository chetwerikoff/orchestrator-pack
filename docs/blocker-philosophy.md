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
3. **Only explicit blockers; operator lift is absolute.** A blocker exists only
when the operator or the task directive says that it is a blocker. An explicit operator
authorization lifts that blocker unconditionally for the authorized
action; after the authorization, the worker continues without re-litigating
the same blocker.
