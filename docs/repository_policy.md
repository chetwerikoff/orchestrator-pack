# Repository publishing policy

This repository should contain only reusable `orchestrator-pack` material that can
be applied to other projects.

## Commit and push

Allowed categories:

- `plugins/**` — external plugin implementations/contracts/tests;
- `prompts/**` — reusable prompt fragments and agent rules;
- `scripts/**` — reusable setup, verification, guard, and developer scripts;
- `.github/workflows/**` — reusable CI checks;
- `docs/**` — reusable architecture, migration, and usage notes;
- `.cursor/rules/**` — always-applied Cursor project rules (thin pointers to
  canonical prompts; see architecture §S);
- config examples such as `agent-orchestrator.yaml.example`;
- repository metadata such as `README.md`, `AGENTS.md`, `.gitignore`, and
  package/tooling config for this pack.

Do not commit or push:

- real `agent-orchestrator.yaml` files for a target repo;
- `.env*` secrets, tokens, certificates, SSH keys, or local credential files;
- AO runtime/session state: `.ao/`, `.agent-orchestrator/`, ledgers/databases;
- target repository clones, worktrees, scratch directories, or generated logs;
- `vendor/agent-orchestrator` or any modified upstream AO source;
- `packages/core/**` patches from Composio AO.

## Agent skills (single canonical source)

Each skill is authored **once** under `.claude/skills/<name>/SKILL.md` (canonical).
Every other agent surface — today `.cursor/skills/<name>/SKILL.md` — is a **generated
pointer**: discovery frontmatter (`name`, `description`) is derived from the canonical
file; the body only directs the agent to read and execute the canonical `SKILL.md`.

After editing a canonical skill, run `pwsh scripts/generate-skill-pointers.ps1` when you
add a skill or change frontmatter. Pointer bodies do not need edits when only the
canonical instruction body changes. CI runs `scripts/check-skill-pointer-drift.ps1` inside
`scripts/verify.ps1` so hand-edited pointers cannot merge.

Target surfaces are listed in `scripts/skill-pointer-targets.json` (list-driven; no
per-skill generator code).

## Local pre-push check

Before pushing, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-reusable.ps1
```

Optional local hook, after this directory is a Git repo:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

The hook is not committed by Git, but the installer script is reusable. It makes
`git push` run both pack verification and the reusable-content guard locally.

On Windows PowerShell without `pwsh`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-reusable.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1
```

## GitHub protection

After the GitHub repo exists, protect the default branch so direct pushes cannot
bypass the guard:

1. Require pull requests before merging.
2. Require the `scope-guard` workflow to pass.
3. Require `scripts/check-reusable.ps1` to pass in CI.
4. Disable or restrict direct pushes to `main`.
5. Keep auto-merge off unless the reusable-content guard is required and green.

CI is the server-side backstop. The local `.gitignore` and `check-reusable.ps1`
are the developer-side backstop.

## Spec-only docs PRs

Use this path when landing **spec drafts** or **skill instruction markdown** to
`main` (for example `docs/issues_drafts/**`, `docs/issue_queue_index.md`, or
`.claude/skills/**/SKILL.md`) without closing the implementation GitHub Issue
and without a declaration snapshot.

### PR body contract

1. **Spec-only signal** — include this HTML comment **alone on one line** near the
   top of the PR description (machine-detectable; does not render in the GitHub UI).
   Inline mentions, backticks, or fenced examples do not count:

   ```html
   <!-- pr-type: spec-only -->
   ```

2. **Non-closing issue reference** — link the implementation issue with a form
   GitHub will **not** auto-close on merge, for example `Refs #N`. Accepted
   keywords: `Ref`, `Refs`, `See`, `Related to` (case-insensitive, `#` required).

3. **Do not** use `Closes`, `Fixes`, `Resolves`, or other GitHub closing
   keywords on spec-only PRs. Scope guard fails if both the spec-only signal and
   a closing keyword are present.

### Spec-docs allowlist (runtime)

Every changed path in the PR diff must match **one** of:

- `docs/issues_drafts/**`
- `docs/issue_queue_index.md`
- `docs/architecture.md`
- `docs/issues_drafts/00-architecture-decisions.md`
- **Skill instruction markdown** (markdown only):
  - `.claude/skills/**/*.md` — canonical skill source
  - `.cursor/skills/**/*.md` — generated pointer surface

**Markdown-only skill boundary:** only `.md` files under the skill directories
above qualify. A non-markdown file under `.claude/skills/**` or
`.cursor/skills/**` (script, binary, or other asset) does **not** match the
allowlist and must use the implementation PR path.

Paths outside this combined list (including `scripts/**`, `plugins/**`,
`.github/**`, non-markdown skill assets, `README.md`,
`agent-orchestrator.yaml.example`, and `docs/declarations/**`) cause scope guard
to fail. No committed declaration snapshot is required for this PR shape.

The skill-pointer drift check (`scripts/check-skill-pointer-drift.ps1`, run from
`scripts/verify.ps1`) still applies on spec-only skill PRs — canonical/pointer
mismatch or a hand-edited pointer fails CI independently of this allowlist.

## No-ceremony markdown PRs (diff-content only)

Use this path when the **entire PR diff** is markdown within the **union** of
spec-docs surfaces and agent skill instruction markdown — no GitHub Issue, no
`<!-- pr-type: spec-only -->` signal, and no declaration snapshot. Scope guard
detects the shape from **diff-content only** (automatic; the author adds no
PR-body marker).

### Diff-content trigger (union surface)

Every changed path must match **one** of:

**Spec-docs markdown** (markdown-only subset of the spec-only allowlist):

- `docs/issues_drafts/**/*.md`
- `docs/issue_queue_index.md`
- `docs/architecture.md`
- `docs/issues_drafts/00-architecture-decisions.md`

**Skill instruction markdown:**

- `.claude/skills/**/*.md` — canonical skill source
- `.cursor/skills/**/*.md` — generated pointer surface

The shape is **conjunctive**: if any changed path is outside this union (code,
workflows, `README.md`, `agent-orchestrator.yaml.example`,
`docs/declarations/**`, a non-markdown file under `docs/issues_drafts/**` or a
skill directory, and so on), the PR does **not** qualify and falls through to
spec-only (when signalled) or implementation handling unchanged.

A PR may mix skill markdown and spec-docs markdown freely when **every** path
stays within the union.

**Markdown-only boundary:** only `.md` paths within the surfaces above qualify.
Non-markdown assets force the implementation path.

### What no-ceremony PRs omit

No-ceremony PRs pass scope guard **without**:

- a committed declaration snapshot under `docs/declarations/**`;
- any issue reference in the PR body (`Closes`, `Refs`, `See`, `Related to`, and
  so on — absence is never a failure reason for this shape);
- the spec-only HTML comment signal.

Scope guard **fails** when the PR body links any GitHub issue in any common form:
closing keywords (`Closes` / `Fixes` / `Resolves`), non-closing forms (`Ref` /
`Refs` / `See` / `Related to`), bare `#N` autolinks, or
`https://github.com/<owner>/<repo>/issues/<N>` URLs (fenced-code examples are
ignored). No-ceremony PRs must not reference an issue in the description.

### Safety gates (unchanged)

- Conjunctive diff boundary — no-ceremony PRs cannot carry code or other surfaces.
- Skill-pointer drift check (`scripts/check-skill-pointer-drift.ps1`, run from
  `scripts/verify.ps1`) remains a **separate required gate** when the diff
  includes skill markdown paths.

### Implementation PRs (unchanged)

Worker and direct-fix PRs still require `Closes #N` / `Fixes #N` /
`Resolves #N`, a committed snapshot under `docs/declarations/<N>.*.json`, and
validation against the issue-body fences.
