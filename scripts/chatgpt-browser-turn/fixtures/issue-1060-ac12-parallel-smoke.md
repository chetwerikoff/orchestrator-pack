# Issue #1060 AC12 — headed-Chrome parallel smoke evidence

Body-free operator evidence for two independent concurrent turns plus same-conversation overlap control.

## Preconditions

- Configured headed Chrome on `http://127.0.0.1:9222`
- Profile `/mnt/c/pw-probe-profile` with `status/list.state != profile_blocked`
- Two distinct existing project conversations (`--chat-url`, not `--new-chat`)

## Concurrent independent turns

```bash
mkdir -p /tmp/ac12-1060
printf 'ac12 smoke A\n' > /tmp/ac12-1060/a.txt
printf 'ac12 smoke B\n' > /tmp/ac12-1060/b.txt
npm run chatgpt-browser-turn -- turn \
  --profile /mnt/c/pw-probe-profile --cdp http://127.0.0.1:9222 \
  --chat-url '<conversation-a>' --input /tmp/ac12-1060/a.txt --output /tmp/ac12-1060/a.out &
npm run chatgpt-browser-turn -- turn \
  --profile /mnt/c/pw-probe-profile --cdp http://127.0.0.1:9222 \
  --chat-url '<conversation-b>' --input /tmp/ac12-1060/b.txt --output /tmp/ac12-1060/b.out &
wait
```

Pass: both turn-result lines are `state: ok` with distinct `conversation_id` values and committed `output` metadata; neither reports `profile_busy`.

## Same-conversation overlap control

While one turn still holds the conversation lock (or simulate with overlapping dispatch), a second turn on the same `--chat-url` must refuse with `conversation_busy` before duplicate send.

## Recorded run (operator)

Fill after live execution:

| field | value |
| --- | --- |
| `recorded_at` | |
| `profile_key` | |
| `turn_a_invocation_id` | |
| `turn_b_invocation_id` | |
| `turn_a_conversation_id` | |
| `turn_b_conversation_id` | |
| `overlap_control_state` | `conversation_busy` |
| `notes` | body-free control metadata only |
