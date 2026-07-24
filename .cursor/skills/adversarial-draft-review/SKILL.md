---
name: adversarial-draft-review
description: Use when the user asks to adversarially challenge a draft/spec artifact with Codex — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". With only a brief and no artifact, route through create-issue-draft's brief-only entry and run the requested Codex loop in-flow before Issue acceptance. Otherwise run the standalone Codex challenge loop (≤3 cold passes, evaluate-don't-obey) over a local markdown artifact. Also the recorded-substitution engine for create-issue-draft when browser GPT is unavailable. Skip plain "создай драфт" with no «с кодексом»/adversarial marker.
---

Read and execute [`.claude/skills/adversarial-draft-review/SKILL.md`](../../../.claude/skills/adversarial-draft-review/SKILL.md) in full. Do not re-derive the workflow inline.
