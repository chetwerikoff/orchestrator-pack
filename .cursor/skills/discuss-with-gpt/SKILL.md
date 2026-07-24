---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". With only a brief and no artifact, route through create-issue-draft's brief-only entry and preserve the requested GPT competitive stage before acceptance. Otherwise run the standalone GPT adversarial loop (≤3 fresh-chat passes, evaluate-don't-obey) over a local markdown artifact. Also the canonical tracked browser-turn mechanics home for create-issue-draft: one-shot task/review turns use `npm run chatgpt-browser-turn`, while `driver.mjs` retains standalone adversarial prompt/validation duties. Browser-GPT twin of adversarial-draft-review; for «с кодексом» use that skill. Skip plain "создай драфт" with no «с gpt» marker.
---

Read and execute [`.claude/skills/discuss-with-gpt/SKILL.md`](../../../.claude/skills/discuss-with-gpt/SKILL.md) in full. Do not re-derive the workflow inline.
