from __future__ import annotations

import re
from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_exact(path: str, old: str, new: str, count: int | None = None) -> None:
    text = read(path)
    found = text.count(old)
    if found == 0:
        if new in text:
            return
        raise SystemExit(f"missing expected text in {path}: {old[:120]!r}")
    if count is not None and found != count:
        raise SystemExit(f"unexpected occurrence count in {path}: expected {count}, found {found}")
    write(path, text.replace(old, new))


cache = "docs/pr-session-binding-cache.mjs"
cache_text = read(cache)
pattern = re.compile(
    r"export function loadPushRegisterVerifiedSessions\(options = \{\}\) \{.*?\n\}\n\nfunction resolveRepoSlugFromEnvOrCwd",
    re.DOTALL,
)
replacement = """export function loadPushRegisterVerifiedSessions(options = {}) {
  const provided = toArray(options.sessions);
  if (provided.length > 0) {
    return { ok: true, sessions: provided, source: 'provided' };
  }

  // Runtime discovery belongs to RuntimeAdapter callers. This cache layer accepts
  // only a caller-provided, already-verified worker corpus and never shells out.
  return { ok: false, reason: 'push_register_session_verification_required', sessions: [] };
}

function resolveRepoSlugFromEnvOrCwd"""
updated, substitutions = pattern.subn(replacement, cache_text, count=1)
if substitutions == 0 and "push_register_session_verification_required" not in cache_text:
    raise SystemExit("loadPushRegisterVerifiedSessions block not found")
if substitutions:
    write(cache, updated)

reviewer = "plugins/codex-pr-reviewer/tests/reviewer-budget.test.ts"
replace_exact(reviewer, "import { spawnSync } from 'node:child_process';\n", "")
replace_exact(
    reviewer,
    "import { executeReview } from '../lib/review_core.js';\n",
    """import { executeReview } from '../lib/review_core.js';
import { runProcessSync } from '../../../scripts/kernel/subprocess.ts';

interface TestProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly encoding?: BufferEncoding;
}

function runTestProcessSync(
  command: string,
  args: readonly string[],
  options: TestProcessOptions = {},
) {
  const result = runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: options.env === undefined,
    encoding: options.encoding ?? 'utf8',
  });
  return {
    status: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
""",
)
replace_exact(reviewer, "spawnSync(", "runTestProcessSync(", count=17)

router = "scripts/orchestrator-escalation-router.test.ts"
replace_exact(router, "import { spawnSync } from 'node:child_process';\n", "")
replace_exact(
    router,
    "import { afterEach, describe, expect, it } from 'vitest';\n",
    """import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';

interface TestProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly encoding?: BufferEncoding;
}

function runTestProcessSync(
  command: string,
  args: readonly string[],
  options: TestProcessOptions = {},
) {
  const result = runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: options.env === undefined,
    encoding: options.encoding ?? 'utf8',
  });
  return {
    status: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
""",
)
replace_exact(router, "spawnSync(", "runTestProcessSync(", count=5)

gh_test = "scripts/gh-wrapper.test.ts"
replace_exact(
    gh_test,
    "import { tmpdir } from 'node:os';\n",
    "import { tmpdir } from 'node:os';\nimport { runProcessSync } from './kernel/subprocess.ts';\n",
)
replace_exact(
    gh_test,
    """    const result = spawnSync(join(import.meta.dirname, 'gh'), ['auth', 'status'], {
      env: {
""",
    """    const result = runProcessSync({
      command: join(import.meta.dirname, 'gh'),
      args: ['auth', 'status'],
      env: {
""",
)
replace_exact(gh_test, "    expect(result.status).toBe(0);", "    expect(result.exitCode).toBe(0);", count=1)

pr_test = "scripts/pr-session-binding-cache.test.ts"
for old, new in (
    ("push_register_missing_session_identity", "push_register_session_verification_required"),
    ("rejects env-only spoof without verified AO session corpus", "rejects env-only spoof without a caller-verified runtime worker corpus"),
    ("push_register_session_verify_failed", "push_register_session_verification_required"),
    ("/definitely/not/a/dir/cache.json", "/dev/null/cache.json"),
    ("parses ao session get payload into worker row", "parses a captured legacy worker payload into a runtime-neutral row"),
):
    replace_exact(pr_test, old, new)
