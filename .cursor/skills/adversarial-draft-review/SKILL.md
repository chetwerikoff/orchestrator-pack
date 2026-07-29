---
name: adversarial-draft-review
description: Use when the user asks to adversarially challenge a draft/spec artifact with Codex — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". Runs a standalone Codex challenge loop (≤3 cold passes, evaluate-don't-obey) over a local markdown artifact. Codex is not a create-issue-draft reviewer or outage substitute; an explicit request to create/manage a task with Codex routes to create-issue-draft with Codex as the flow-manager instead. Skip plain "создай драфт" with no «с кодексом»/adversarial marker.
---

Read and execute [`.claude/skills/adversarial-draft-review/SKILL.md`](../../../.claude/skills/adversarial-draft-review/SKILL.md) in full. Do not re-derive the workflow inline.
