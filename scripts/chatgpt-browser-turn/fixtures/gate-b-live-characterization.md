# Gate-B live characterization (operator attestation)

Half A requires a complete `gate-b-characterization.json` for the exact configured profile/CDP binding before proven non-delivery may be minted.

## Command

```bash
npm run chatgpt-browser-turn -- gate-b-characterization \
  --profile /mnt/c/pw-probe-profile \
  --cdp http://127.0.0.1:9222 \
  --chat-url '<active ChatGPT conversation url>'
```

## Acceptance probes

1. `service-worker-owned-http-on-configured-context` — only `BrowserContext` `request` events with truthy `request.serviceWorker()`.
2. `worker-or-secondary-target-websocket-frame-sent` — outbound `Network.webSocketFrameSent` on configured-context CDP sessions.

The probe reloads the selected chat and best-effort reloads sibling same-context tabs to surface extension service-worker HTTP without CDP stimulus.

## Record location

`~/.local/state/orchestrator-pack/chatgpt-browser-turn/<configured_profile_key>/gate-b-characterization.json`
