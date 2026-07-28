---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". With only a brief and no artifact, route through create-issue-draft's brief-only entry; that wrapper floors tier at T2 and requires the competitive pre-stage before the terminal GPT architectural lens. Otherwise run the standalone GPT adversarial loop (≤3 fresh-chat passes, evaluate-don't-obey) over a local markdown artifact. Also the canonical tracked browser-turn mechanics home for create-issue-draft; its one-shot turns use `npm run chatgpt-browser-turn`, while `driver.mjs` retains standalone adversarial duties. Browser-GPT twin of adversarial-draft-review; for «с кодексом» use that skill. Skip plain "создай драфт" with no «с gpt» marker.
---

Read and execute [`.claude/skills/discuss-with-gpt/SKILL.md`](../../../.claude/skills/discuss-with-gpt/SKILL.md) in full. Do not re-derive the workflow inline.
