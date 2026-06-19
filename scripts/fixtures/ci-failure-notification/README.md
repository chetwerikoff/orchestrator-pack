# CI-failure notification fixtures

Minimized, redacted captures for Issues #283 / #342 predicate and lifecycle tests.

- `reaction-action-succeeded.json` — bindable `reaction.action_succeeded` with full episode key
- `canonical-ci-red.json` — aggregate red-period CI source
- `worker-state-golden.json` — sanitized `{sessions, openPrs}` shape from AO status reader

Fixtures omit secrets, absolute paths, env values, and `.ao` payloads.
