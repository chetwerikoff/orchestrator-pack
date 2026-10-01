# chatgpt-browser-turn

Shared Browser-GPT state-light transport used by multiple orchestrator-pack
workflows. Workflow-specific review/acceptance rules do not live here.

Canonical operator procedure:
[`docs/browser-gpt-turn-runbook.md`](../../docs/browser-gpt-turn-runbook.md).

## Entrypoint

```text
npm run --silent chatgpt-browser-turn -- turn   --invocation-id <id>   --profile <profile>   --cdp <url>   --input <prompt-file>   --output <reply-file>   [--project-url <url> --new-chat | --chat-url <url>]
```

The entrypoint reads stable input, owns one send, observes the exact conversation,
recovers only the same invocation, and atomically publishes the harvested reply.

The command emits one `turn-result/v1` JSON result. Possible/proven delivery
forbids blind resend. Timeouts, process liveness, or missing local artifacts do
not manufacture non-delivery.

`session` reuses the same transport contracts for an explicitly owned
conversation. Use `browser-gpt-page-probe` only for read-only diagnosis.
