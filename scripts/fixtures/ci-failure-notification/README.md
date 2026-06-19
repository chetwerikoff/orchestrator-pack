# CI-failure notification fixtures

Minimized, redacted captures for Issues #283 / #342 predicate and lifecycle tests.

- `reaction-action-succeeded.json` — bindable `reaction.action_succeeded` with full episode key
- `canonical-ci-red.json` — aggregate red-period CI source
- `worker-state-golden.json` — sanitized `{sessions, openPrs}` shape from AO status reader
- `ci-failure-worker-state-base.json` — shared sanitized openPr/session shell for capture scenarios
- `live-worker-fixing-ci-captured.json` — capture-backed positive-outcome scenario delta (session `stuck`, head report `fixing_ci`)
- `live-worker-same-head-recency.json` — newer non-`fixing_ci` report wins over older `fixing_ci` for same head
- `live-worker-stale-head-fixing-ci.json` — `fixing_ci` only on a head older than the episode head

Fixtures omit secrets, absolute paths, env values, and `.ao` payloads.
