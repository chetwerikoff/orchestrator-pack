# Single canonical source for agent skills (kill .claude/.cursor drift)

GitHub Issue: #156

## Prerequisite

None. Independent of `docs/issues_drafts/54-ci-path-filter-markdown-only.md`
(GitHub #155), though both reduce the cost of changing skills.

## Goal

A skill must be authored **once** and apply to every agent surface. Today the
same seven skills exist under both `.claude/skills/**` and `.cursor/skills/**`:
three are already thin pointers ("Read and execute the `.claude/...` SKILL in
full"), but four are full copies, and the copies have already drifted from
their `.claude/` originals. Editing a skill therefore means hand-editing two
files and hoping they stay in sync. Outcome: one canonical source per skill;
every other agent surface is a generated pointer to it; drift is impossible to
merge because CI fails on it. Adding or editing a skill becomes a single-file
change.

## Binding surface

This task commits the repo to a **single-canonical-source** convention for
skills (Mode 2 / assumption destruction — eliminate the duplicated literal):

- Each skill has exactly **one** full-content source surface. The existing
  convention (the three current pointers already target `.claude/skills/…`)
  makes `.claude/skills/<name>/SKILL.md` the canonical source; keep it unless a
  reason to relocate is recorded.
- Every **non-canonical** agent surface copy of a skill is a **generated
  pointer**: it carries only the frontmatter needed for that agent to discover
  the skill (derived from the canonical skill's frontmatter) plus a body that
  directs the agent to read and execute the canonical `SKILL.md` in full. It
  never contains a second copy of the instructions.
- A **generator** produces/refreshes the pointer surfaces from the canonical
  set, and a **drift check** fails when any pointer is missing or differs from
  what the generator would produce. The check runs locally and inside the
  existing required CI check so a stale or hand-edited pointer cannot merge.
- The mechanism is **list-driven** (enumerates skills and target surfaces),
  so adding a new skill or a new agent surface needs no per-skill code.

## Files in scope

- `scripts/**` — a skill-pointer generator and a drift check (new); wiring the
  drift check into the existing read-only pack verification so it runs in the
  required `Verify orchestrator-pack structure` job.
- `.cursor/skills/**` — regenerate all pointer files; convert the four
  full-copy skills (`create-issue-draft`, `investigate-root-cause`,
  `publish-issue-draft`, `study-external-source`) to pointers; normalize the
  three existing pointers to the generated form.
- A short note documenting the single-canonical-source rule where skills/repo
  conventions are already described (no new top-level doc required).
- `docs/issues_drafts/55-skills-single-source-mirror.md` — this spec.

## Files out of scope

- `.claude/skills/**` skill **bodies** — canonical content is not rewritten by
  this task (only mechanical normalization if the generator also owns canonical
  frontmatter; no instruction changes).
- Agent **rule** surfaces that are not skills: `AGENTS.md`,
  `prompts/agent_rules.md`, `.cursor/rules/**` (their fan-out is governed by
  other drafts, e.g. #149).
- CI job gating / path filtering (that is #155).
- AO core, vendor, packages/core.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
.claude/skills/**
.cursor/skills/**
docs/**
```

## Acceptance criteria

- Every `.cursor/skills/<name>/SKILL.md` is a generated pointer: it does **not**
  contain a full second copy of the canonical instructions, and its body
  directs the agent to read/execute the canonical `.claude/skills/<name>/SKILL.md`.
- The four currently-duplicated skills are converted to pointers; the three
  existing pointers end in the same generated form.
- Each pointer's discovery frontmatter (at least `name` and `description`) is
  derived from the canonical skill, so it cannot silently disagree with it.
- Running the generator on a clean checkout produces **no** git diff
  (committed pointers equal generated output — idempotent).
- The drift check **fails** when a pointer is missing, hand-edited away from the
  generated form, or a canonical skill has no pointer; it **passes** on the
  committed tree. It executes within the existing required pack-verification
  CI job (no new required check, no branch-protection change).
- Changing only a canonical skill **body** (no pointer edit) keeps the drift
  check green — proving pointers are body-independent and a skill edit is a
  single-file change.
- Adding a new skill or a new target surface does not require editing per-skill
  logic in the generator/check (list/enumeration-driven), provable by reading
  the generator.

## Upgrade-safety check

- No AO version assumption; no AO YAML schema change; no new repository secret.
- No edit to `vendor/`, `packages/core/`, or `.ao/`.
- Pointer bodies preserve current behaviour: agents already follow the existing
  three pointers, so converting the remaining four does not change what any
  agent executes.
- The drift check is wired into an **already-required** job, not a new required
  status check, so merge protection is unchanged.

## Verification

- Run the generator on a clean tree → `git status` shows no change.
- Edit one `.cursor/skills/*/SKILL.md` by hand (or delete it) → drift check
  exits non-zero with a message naming the offending skill; revert → passes.
- Append a throwaway canonical skill dir under `.claude/skills/` → generator
  creates its pointer; drift check then passes; remove both for cleanup.
- Edit a canonical skill body only, regenerate → no pointer diff, drift check
  green.
- Confirm by reading the workflow/verify entrypoint that the drift check runs
  in the `Verify orchestrator-pack structure` job.
