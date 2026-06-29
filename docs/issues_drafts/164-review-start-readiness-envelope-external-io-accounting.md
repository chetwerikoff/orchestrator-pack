# Review-start readiness envelope external I/O accounting (Issue #515)

```behavior-kind
action-producing
```

## Goal

Classified infra transport during mandatory pre-launch supervised `gh` must not consume the readiness envelope; reaper uses the same accounting; hung `gh` is killed under supervision; monotonic absolute attempt ceiling prevents livelock.

## Acceptance criteria

1. **Infra stall does not exhaust envelope.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: infra-stall-not-envelope-exhausted
proof-command: npm test -- review-start-envelope-external-io
```

2. **PR #510-shaped pass + reproduce.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: pr510-shaped-pass-and-reproduce
proof-command: npm test -- review-start-envelope-external-io
```

3. **Reaper parity.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: reaper-pause-parity
proof-command: npm test -- review-start-envelope-external-io
```

4. **Infra vs not-ready classification.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: not-ready-and-auth-not-classified-as-infra
proof-command: npm test -- review-start-envelope-external-io
```

5. **Monotonic absolute ceiling.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: monotonic-attempt-ceiling-terminalizes
proof-command: npm test -- review-start-envelope-external-io
```

6. **Hung gh + claim-loss kill.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: hung-gh-and-claim-loss-cleanup
proof-command: npm test -- review-start-envelope-external-io
```

7. **#481 hold semantics preserved.**

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-external-io
expected: hold-semantics-481-preserved
proof-command: npm test -- review-start-claim-budget-semantics review-start-envelope-external-io
```

```positive-outcome
asserts: when a ready uncovered head hits transient gh transport failure during preflight then recovers, automated review starts exactly once without operator hand-launch
input: external-tool-output
provenance: capture-backed
```

```contract-evidence
binding-id: orchestrator-pack:review-start-envelope-external-io:infra-stall-not-envelope-exhausted
binding-type: cli-behavior
binding: classified infra transport stall during preflight does not solely exhaust readiness envelope
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-envelope-external-io:pr510-shaped-pass-and-reproduce
binding-type: cli-behavior
binding: PR510-shaped infra stall pattern converges to run_started; reproduce captures pre-fix stall
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-envelope-external-io:reaper-pause-parity
binding-type: cli-behavior
binding: liveness reaper uses same infra pause accounting as foreground starters
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-start-envelope-external-io:not-ready-and-auth-not-classified-as-infra
binding-type: cli-behavior
binding: readiness-not-met and auth-rate-config errors are not classified as infra transport
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:review-start-envelope-external-io:monotonic-attempt-ceiling-terminalizes
binding-type: cli-behavior
binding: monotonic firstAttemptAt ceiling terminalizes uncovered head without wall-clock suspend loophole
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:review-start-envelope-external-io:hung-gh-and-claim-loss-cleanup
binding-type: cli-behavior
binding: hung supervised gh aborts at ceiling and claim-loser kills orphan child
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:review-start-envelope-external-io:hold-semantics-481-preserved
binding-type: cli-behavior
binding: post-481 hold budget semantics remain correct after envelope pause fix
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
```
