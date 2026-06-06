---
name: investigate-root-cause
description: Use when the user asks for causes of a failure or recurrence — e.g. "разобраться с причиной", "в чём причина", "что это", "разберись", "почему упал", "что сломалось", "отладь", "что случилось", "почему не работает", "root cause", "why did", "figure out why", "investigate the cause", "wtf". Delivers a 6-part report (plain-language summary, technical causes, numbered now/prevention steps, repo status; all actions in now or prevention only). §4 Planned requires ship check (issue state, merged PRs, main) so done work is not listed as future. Skip for pure implementation, external adoption (study-external-source), or when one tracked issue already fully answers the ask.
---

Read and execute [`prompts/investigate_root_cause.md`](../../../prompts/investigate_root_cause.md) in full. Do not re-derive the workflow inline.

Issue #221 loaders (canonical text lives in that file):

- **recurrence-diagnostic** — first step when a bug is "already fixed"; `pass + reproduce` ⇒ strong evidence of spec/fixture defect (not exclusive).
- **5-Whys stop condition** — reject "returned/logged X" and imprecise defer records as **terminal root cause**; continue to field-level facts.
- **parked root** — defer suspected root causes only via the structured `parked-root-cause` block in draft authoring (see `create-issue-draft`).
