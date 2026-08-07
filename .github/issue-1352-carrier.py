from __future__ import annotations

import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if old in text:
        target.write_text(text.replace(old, new, 1), encoding="utf-8")
        return
    if new not in text:
        raise SystemExit(f"missing expected text in {path}: {old!r}")


def replace_all(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if old in text:
        target.write_text(text.replace(old, new), encoding="utf-8")
        return
    if new not in text:
        raise SystemExit(f"missing expected text in {path}: {old!r}")


snapshot = "scripts/lib/reverify-bound-issue-snapshot.ts"
replace_once(
    snapshot,
    "import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';\nimport { dirname, join, resolve } from 'node:path';",
    "import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';\nimport { homedir } from 'node:os';\nimport { dirname, join, resolve } from 'node:path';",
)
replace_once(snapshot, "import { getAoProjectDir } from '../../docs/review-run-liveness.mjs';\n", "")
replace_all(snapshot, "resolveDefaultAoProjectId", "resolveDefaultProjectId")
replace_once(
    snapshot,
    "  return (env.AO_PROJECT_ID ?? env.AO_PROJECT ?? 'orchestrator-pack').trim() || 'orchestrator-pack';",
    "  return (env.OPK_PROJECT_ID ?? 'orchestrator-pack').trim() || 'orchestrator-pack';",
)
replace_once(
    snapshot,
    "  return join(getAoProjectDir(projectId, options.stateBaseDir), BOUND_ISSUE_SNAPSHOT_STORE_REL);",
    "  const baseDir = options.stateBaseDir ?? process.env.OPK_BASE_DIR?.trim() ?? join(homedir(), '.orchestrator-pack');\n  return join(baseDir, 'projects', projectId.trim() || 'orchestrator-pack', BOUND_ISSUE_SNAPSHOT_STORE_REL);",
)

for path in (
    "scripts/bound-issue-snapshot-cli.ts",
    "scripts/invoke-contract-evidence-reverify.ts",
    "scripts/invoke-reviewer-contract-mapping.ts",
):
    replace_all(path, "resolveDefaultAoProjectId", "resolveDefaultProjectId")
    replace_all(
        path,
        "AO project id (default: AO_PROJECT_ID or orchestrator-pack)",
        "pack project id (default: OPK_PROJECT_ID or orchestrator-pack)",
    )
    replace_all(
        path,
        "AO project id for bound issue snapshot store",
        "pack project id for bound issue snapshot store",
    )

for path in (
    "scripts/lib/pack-review-delivery.ts",
    "scripts/pr2-foundation/worker-notification-target.ts",
    "scripts/pr2-foundation/worker-nudge-claim-store.ts",
):
    replace_all(path, "'.agent-orchestrator'", "'.orchestrator-pack'")

target = "scripts/pr2-foundation/worker-notification-target.ts"
replace_all(target, "process.env.AO_APP_STATE_PATH", "process.env.OPK_APP_STATE_PATH")
replace_all(target, "'ao_session_list_failed'", "'runtime_worker_list_failed'")
replace_all(target, "'ao_session_list'", "'runtime_worker_list'")

declaration_path = Path("docs/declarations/1352.pr-scope.json")
declaration = json.loads(declaration_path.read_text(encoding="utf-8"))
additions = [
    ".cursor/skills/change-orchestrator-runtime/SKILL.md",
    "CLAUDE.md",
    "docs/orchestrator-wake-runbook.md",
    "docs/review-bulk-send-diagnose.mjs",
    "docs/review-mechanical-cli.mjs",
    "docs/review-run-liveness.d.mts",
    "docs/ubuntu-setup-runbook.md",
    "scripts/bootstrap.ps1",
    "scripts/bound-issue-snapshot-cli.ts",
    "scripts/check-gh-inventory-static.ps1",
    "scripts/check-operator-adoption-example.ps1",
    "scripts/invoke-contract-evidence-reverify.ts",
    "scripts/invoke-reviewer-contract-mapping.ts",
    "scripts/lib/Get-OrchestratorWorktreeHygiene.ps1",
    "scripts/lib/Get-OrchestratorYamlRules.ps1",
    "scripts/lib/Get-PackReviewCommand.ps1",
    "scripts/lib/Get-ReactionMessagesFromYaml.ps1",
    "scripts/lib/OpkVitestChildProcessEnv.ps1",
    "scripts/lib/Review-RunLiveness.ps1",
    "scripts/pr-scope-check.ps1",
    "scripts/pr2-foundation/terminalized/review-bulk-send-diagnose.ts",
    "scripts/review-wake-trigger.test.ts",
    "scripts/run-vitest-with-harness.mjs",
    "scripts/verify.ps1",
]
for path in additions:
    if path not in declaration["declared_paths"]:
        declaration["declared_paths"].append(path)
declaration_path.write_text(json.dumps(declaration, indent=2) + "\n", encoding="utf-8")
