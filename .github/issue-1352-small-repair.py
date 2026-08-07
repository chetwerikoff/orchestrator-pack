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
        raise SystemExit(f"missing expected text in {path}: {old[:100]!r}")


binding = "docs/review-start-claim-run-binding.mjs"
replace_once(binding, "import { toArray } from './review-run-liveness.mjs';\n", "")
replace_once(
    binding,
    "import { normalizeLegacyReviewRunStatus } from './review-reconcile-primitives.mjs';",
    "import { normalizeLegacyReviewRunStatus, toArray } from './review-reconcile-primitives.mjs';",
)

lifecycle = "docs/review-start-claim-lifecycle.mjs"
replace_once(
    lifecycle,
    "/**\n * Review-start claim lifecycle predicates (Issue #417).",
    "import { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\n/**\n * Review-start claim lifecycle predicates (Issue #417).",
)
replace_once(
    lifecycle,
    "import { printJson, readStdinJson, resolveBoundedInt, runAsyncStdinJsonCliMain } from './review-mechanical-cli.mjs';",
    "import { asRecord, printJson, readStdinJson, resolveBoundedInt, runAsyncStdinJsonCliMain, toArray } from './review-mechanical-cli.mjs';",
)
replace_once(
    lifecycle,
    """import {
  asRecord,
  classifyReviewerLiveness,
  readCurrentBootHash,
  readProcStartTimeTicks,
  toArray,
} from './review-run-liveness.mjs';
""",
    "",
)
helpers = """

function readCurrentBootHash() {
  try {
    return createHash('sha256')
      .update(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
      .digest('hex')
      .slice(0, 16);
  } catch {
    return null;
  }
}

function readProcStartTimeTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const rest = stat.slice(end + 2).trim().split(/\\s+/);
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

function classifyExactProcessIdentity(sidecar, options = {}) {
  const identity = asRecord(sidecar?.identity);
  const processIdentity = asRecord(identity?.process);
  if (identity?.kind !== 'linux_proc_pid_starttime_boot' || !processIdentity) {
    return { outcome: 'ambiguous', reason: 'unsupported_or_missing_identity' };
  }
  const pid = Number(processIdentity.pid);
  const expectedStart = String(processIdentity.startTimeTicks ?? '').trim();
  const expectedBoot = String(processIdentity.bootIdHash ?? '').trim();
  if (!Number.isInteger(pid) || pid <= 0 || !expectedStart || !expectedBoot) {
    return { outcome: 'ambiguous', reason: 'partial_identity' };
  }
  if (process.platform !== 'linux' && !options.allowNonLinuxProc) {
    return { outcome: 'ambiguous', reason: 'process_table_unverifiable' };
  }
  const bootHash = options.bootIdHash ?? readCurrentBootHash();
  if (!bootHash || bootHash !== expectedBoot) {
    return { outcome: 'ambiguous', reason: 'boot_identity_unverifiable' };
  }
  const actualStart = options.procStartTimeTicks ?? readProcStartTimeTicks(pid);
  if (!actualStart) return { outcome: 'provably_not_alive', reason: 'proc_entry_missing' };
  if (String(actualStart) !== expectedStart) {
    return { outcome: 'provably_not_alive', reason: 'pid_reused_or_wrong_instance' };
  }
  return { outcome: 'alive', reason: 'pid_starttime_boot_match' };
}
"""
replace_once(lifecycle, "export const DEFAULT_REAPER_PERIOD_SECONDS = 30;\n", "export const DEFAULT_REAPER_PERIOD_SECONDS = 30;" + helpers + "\n")
replace_once(
    lifecycle,
    "const liveness = classifyReviewerLiveness(holderToLivenessSidecar(holder), {",
    "const liveness = classifyExactProcessIdentity(holderToLivenessSidecar(holder), {",
)

harness = "scripts/lib/vitest-live-store-harness.mjs"
replace_once(
    harness,
    """export function resolvedLiveStores(env = process.env) {
  return (liveStoreInventory.stores ?? [])
    .filter((store) => !store.excluded)
    .map((store) => resolveStore(store, env));
}
""",
    """export function resolvedLiveStores(env = process.env) {
  return (liveStoreInventory.stores ?? [])
    .filter((store) => !store.excluded)
    .map((store) => resolveStore(store, env))
    .sort((left, right) => Number(left.kind === 'directory') - Number(right.kind === 'directory'));
}
""",
)

baseline_path = Path("scripts/toolchain/powershell-child-tests.json")
baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
baseline["entries"] = [
    entry for entry in baseline["entries"]
    if entry["path"] != "scripts/orchestrator-escalation-router.test.ts"
]
baseline_path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")

scope_path = Path("docs/declarations/1352.pr-scope.json")
scope = json.loads(scope_path.read_text(encoding="utf-8"))
for path in [binding, "scripts/toolchain/powershell-child-tests.json"]:
    if path not in scope["declared_paths"]:
        scope["declared_paths"].append(path)
scope_path.write_text(json.dumps(scope, indent=2) + "\n", encoding="utf-8")
