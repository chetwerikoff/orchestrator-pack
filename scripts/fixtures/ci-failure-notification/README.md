# CI-failure notification fixtures

These fixtures are minimized, redacted captures for Issue #283 predicate tests. They retain
only the fields the predicate binds on: event id, `reaction.action_succeeded`,
`reactionKey=ci-failed`, the full episode key including the active target discriminator, and
canonical aggregate CI red-period context. They intentionally omit raw message payloads,
absolute operator paths, auth material, and unrelated session metadata.
