GitHub Issue: #46

## Prerequisite

- Draft `docs/issues_drafts/12-architect-role-tighten.md` (shipped as GitHub
  Issue #37, merged in commit #41) already provides the `.claude/skills/`
  surface and the `AGENTS.md` skill-path alignment this draft builds on. It is
  **already merged** — not an open blocker. This issue adds a **shared**
  investigation procedure and discovery wrappers for all architect-side agents,
  not only Claude Code.

Background: the user regularly asks to explain *why* something failed or keeps
recurring — e.g. «разобраться с причиной», «в чём причина», «что это»,
«разберись». Today each agent session re-derives the workflow. Skills under
`.claude/skills/` alone are invisible to Cursor's skill loader and to Codex
sessions that read `AGENTS.md` but not Claude's skill index.

**Scope note — interactive architect-side use, not AO roles.** The user runs
Cursor CLI, Codex CLI, and Claude Code **interactively as architect-side
tools**, and this is the context these wrappers target. That is distinct from
the same agents' AO roles (Cursor = planner+coder under AO, Codex = PR reviewer
on a diff), which receive issue bodies / JSON contracts rather than
conversational triggers and are deliberately out of scope here. The user wants
**all three interactive agents** to discover the same procedure when trigger
phrases appear — without naming a skill slug. Discovery is **best-effort**
(model-driven skill invocation and prose-following are not deterministic
guarantees); see Verification.

## Goal

Ship one canonical investigation procedure and three discovery surfaces so that
**any** architect-side agent (Cursor CLI, Codex CLI, Claude Code) automatically
runs the same workflow when the user asks for causes, and returns a structured
memo in the user's language:

1. **Причины** — evidence-backed root cause(s); 5 Whys when the ask is about a
   failure.
2. **Что уже сделано** — mitigations in the repo and whether each worked,
   partially worked, or failed / was wrong.
3. **Что будет сделано** — open GitHub Issues and `docs/issues_drafts/` that
   already plan work on this topic, and what each would change if merged.
4. **Что лучше всего ещё сделать** — ranked gaps not covered by (2)–(3);
   durable fixes are specs/rules, not hand-patches to merged code.

**Single source of truth:** `prompts/investigate_root_cause.md` holds the full
procedure. Skill wrappers and `AGENTS.md` only point at it — they do not
duplicate the workflow body (per `prompts/agent_rules.md` shared-source policy).

**Auto-invoke (best-effort discovery):** on matching user phrasing, agents
should follow the canonical file immediately, so the user does not need to say
«invoke investigate-root-cause». This is a discovery surface, not a hard
guarantee — model-driven skill invocation and `AGENTS.md` prose-following are
probabilistic. The issue commits to *making the procedure discoverable on the
right triggers*, not to a deterministic firing contract.

## Binding surface

This issue commits the repository to:

1. **`prompts/investigate_root_cause.md` (new, canonical)** — complete workflow,
   trigger/skip lists, four-section report template, role boundaries, optional
   Codex self-check guidance.
2. **`AGENTS.md` (modify)** — an **Auto-invoke: root cause investigation** section
   listing trigger phrases and instructing any agent reading `AGENTS.md` to
   follow `prompts/investigate_root_cause.md` when they match (no skill name
   required) — a best-effort directive, not a deterministic gate. Add both
   `.cursor/skills/**` and `CLAUDE.md` to the allowed-edits list (this issue
   touches `CLAUDE.md`, which the current allowed-edits list omits).
3. **`.cursor/skills/<slug>/SKILL.md` (new, thin wrapper)** — Cursor skill loader
   discovery: frontmatter `description` repeats triggers; body instructs to read
   and execute the canonical prompt file. **Must not** set
   `disable-model-invocation: true` (that would block automatic invocation in
   Cursor).
4. **`.claude/skills/<slug>/SKILL.md` (new, thin wrapper)** — same pattern for
   Claude Code; same frontmatter discipline for auto-discovery.
5. **`CLAUDE.md` (modify)** — **Do** bullet: on cause-investigation phrasing,
   follow `prompts/investigate_root_cause.md` (and the matching skill wrapper if
   loaded); do not re-derive inline.
6. **`scripts/check-reusable.ps1` (modify)** — allowlist includes
   `.cursor/skills/*` so PRs touching Cursor skills pass policy checks.

Suggested slug for wrappers: `investigate-root-cause`; planner may rename if a
better identifier exists, but all pointers must use one consistent slug/path.

Observable by reading the canonical prompt + `AGENTS.md` + both wrappers; no
runtime hook.

## Files in scope

- `prompts/investigate_root_cause.md` (new) — canonical procedure.
- `.cursor/skills/<investigate-slug>/SKILL.md` (new) — Cursor discovery wrapper.
- `.claude/skills/<investigate-slug>/SKILL.md` (new) — Claude discovery wrapper.
- `AGENTS.md` — auto-invoke section + `.cursor/skills/**` and `CLAUDE.md` in
  allowed edits.
- `CLAUDE.md` — one **Do** bullet (cause-investigation triggers).
- `scripts/check-reusable.ps1` — add `.cursor/skills/*` to `$allowedPathPatterns`.
- `docs/issues_drafts/18-investigate-root-cause-skill.md` — this spec.

## Files out of scope

- `packages/core/**`, `vendor/**`.
- `prompts/agent_rules.md` — AO worker contract; workers implement scoped issues.
  Cause-investigation is architect-side. (Workers may *read* the canonical file
  as context; this issue does not add a worker auto-invoke rule there.)
- `prompts/codex_review_prompt.md` — PR-review JSON contract; unchanged.
- Other `.claude/skills/**` except the new wrapper.
- `docs/first_principles_5_operational_framework.md` and
  `docs/first_principles_10_critical_framework.md` — referenced, not modified.
- Plugins, scripts (except `check-reusable.ps1` allowlist line), CI workflows.
- `README.md` — optional cross-link; not required by this issue.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
prompts/codex_review_prompt.md
plugins/**
.github/workflows/**
docs/first_principles_5_operational_framework.md
docs/first_principles_10_critical_framework.md
.claude/skills/study-external-source/**
.claude/skills/create-issue-draft/**
.claude/skills/direct-fix-checklist/**
```

```allowed-roots
prompts/investigate_root_cause.md
.cursor/skills/**
.claude/skills/**
AGENTS.md
CLAUDE.md
scripts/check-reusable.ps1
docs/issues_drafts/18-investigate-root-cause-skill.md
```

The `.cursor/skills/**` and `.claude/skills/**` roots stay broad so the planner
can place **one** new wrapper per loader under its chosen slug (planner-freedom).
Existing Claude skills are protected by the denylist above; the planner declares
exactly the two new wrapper files via `ao-declare` and touches no other skill.

## Acceptance criteria

### Canonical prompt (`prompts/investigate_root_cause.md`)

- **Triggers and skips** — document when to run (Russian: «разобраться с
  причиной», «в чём причина», «что это», «разберись», «почему упал», «что
  сломалось», «отладь», «что случилось», «почему не работает»; English/slang:
  «root cause», «why did», «figure out why», «investigate the cause», «wtf»)
  and when to skip (pure implementation with no analysis; external adoption →
  `study-external-source`; single tracked issue already fully answers the ask).
- **Auto-invoke rule** — explicit sentence: if the user's message matches a
  trigger, **start this procedure immediately** without waiting for the user
  to name a skill or file.
- **Workflow sections** — each under a recognizable heading:
  - scope the question;
  - gather evidence (bounded): user context, `ao review list` /
    `code-reviews/findings/` when relevant, PR/review-run artifacts, targeted
    git history;
  - **5 Whys** for failures/recurrence, per
    `docs/first_principles_5_operational_framework.md` §5 Whys Debug Mode; stop
    at spec/contract level. The canonical file **references** the existing
    `CLAUDE.md` §Failure response loop (reproduce → 5 Whys → fix at
    spec/contract → capture lesson) as the source of this sequence rather than
    restating a parallel copy — `CLAUDE.md` §Failure response stays the single
    source for the architect-side loop;
  - search existing mitigations (open/closed issues, `docs/issues_drafts/`,
    architecture decisions, read-only scan of rules/config);
  - search planned work (open issues/drafts);
  - role boundary: durable fixes via `create-issue-draft` + worker spawn, not
    direct implementation edits unless user authorized `direct-fix-checklist`.
- **Report template** — four sections in fixed order (user's language); ≤ 600
  words unless user asked for depth; long tables in `$env:TEMP` only.
- **Don't** — invent causes without evidence; skip queue/architecture search;
  duplicate `study-external-source`; patch merged code as the durable fix.

### Multi-agent discovery (auto-invoke)

- **AGENTS.md** contains a dedicated section that (a) lists the same trigger
  phrases, (b) directs agents to follow `prompts/investigate_root_cause.md`
  when matched (best-effort discovery, not a deterministic gate), (c) names the
  Cursor and Claude wrapper paths (under `.cursor/skills/<slug>` and
  `.claude/skills/<slug>` for the planner's chosen consistent slug) as optional
  loader entry points that defer to the canonical file.
- **Cursor wrapper** — `.cursor/skills/.../SKILL.md` has `name` + `description`
  (third person, triggers in `description`). Body is thin: read and execute
  `prompts/investigate_root_cause.md`. **No**
  `disable-model-invocation: true` in frontmatter.
- **Claude wrapper** — same as Cursor wrapper (thin, same triggers, no
  disable-model-invocation).
- **No body duplication** — each wrapper body contains only the frontmatter plus
  an instruction to read and execute `prompts/investigate_root_cause.md`, and
  carries **none** of the canonical workflow section headings (no «5 Whys»,
  «Report template», «gather evidence», etc.). Provable by grepping each wrapper
  for those headings and confirming zero matches.
- **CLAUDE.md** — **Do** bullet mirrors `AGENTS.md` auto-invoke (triggers +
  canonical path), consistent with `study-external-source` style.

### Policy surface

- **AGENTS.md** allowed-edits list includes `.cursor/skills/**` and `CLAUDE.md`.
- **`scripts/check-reusable.ps1`** includes `.cursor/skills/*` in
  `$allowedPathPatterns`.
- No change to worker-PR `NO_FINDINGS` machine contract.

### Optional Codex self-check

- Canonical file MAY document an optional architect-only Codex pass on a
  transient memo (max 3 iterations, PowerShell-valid, no `<` stdin redirect).
  Not a merge gate.

## Upgrade-safety check

- No AO core / vendor / plugin runtime changes except one allowlist line in
  `check-reusable.ps1`.
- No new secrets or dependencies.
- Markdown-only procedure; wrappers are markdown.

## Verification

- **Static — canonical.** `prompts/investigate_root_cause.md` contains triggers,
  auto-invoke rule, all workflow headings, four-section template, and Don't.
- **Static — AGENTS.md.** Section directs agents to the canonical file on
  triggers (best-effort); `.cursor/skills/**` appears in allowed edits.
- **Static — wrappers.** Both `.cursor/.../SKILL.md` and `.claude/.../SKILL.md`
  exist, have frontmatter without `disable-model-invocation: true`, and point to
  the canonical file without duplicating the workflow body.
- **Scope of verification.** These checks confirm the procedure is *present and
  discoverable* on the right surfaces. They do **not** assert deterministic
  auto-firing — model-driven invocation is probabilistic and is accepted as
  best-effort (see Goal / Prerequisite scope note).
- **Static — CLAUDE.md.** **Do** bullet present with triggers + canonical path.
- **Static — allowlist.** `scripts/check-reusable.ps1` lists `.cursor/skills/*`.
- **Smoke.** `scripts/verify.ps1`, `scripts/check-reusable.ps1`, and
  `scripts/test-all.ps1` clean on PR head.
- **Static — cross-surface consistency.** Each discovery surface (canonical
  prompt, `AGENTS.md` section, both wrappers, `CLAUDE.md` **Do** bullet)
  contains the same trigger phrases and a reference to the same canonical path
  `prompts/investigate_root_cause.md`. Provable by grepping each file for the
  trigger list and the canonical path — no subjective judgement.

