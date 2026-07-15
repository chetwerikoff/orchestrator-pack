#!/usr/bin/env node
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const write = (rel, text) => writeFileSync(path.join(root, rel), text.endsWith('\n') ? text : `${text}\n`, 'utf8');

write('scripts/_resolve-pwsh.sh', `# Shared pwsh resolver for pack bash entry points (Issue #406).\nresolve_pwsh() {\n  if [[ -n \"\${AO_PWSH_BINARY:-}\" && -x \"\${AO_PWSH_BINARY}\" ]]; then\n    printf '%s\\n' \"\${AO_PWSH_BINARY}\"\n    return 0\n  fi\n  if command -v pwsh >/dev/null 2>&1; then\n    command -v pwsh\n    return 0\n  fi\n\n  local candidate\n  for candidate in \\\n    /usr/local/bin/pwsh \\\n    /usr/bin/pwsh \\\n    /opt/microsoft/powershell/7/pwsh \\\n    \"\${HOME}/.local/bin/pwsh\"; do\n    if [[ -x \"\${candidate}\" ]]; then\n      printf '%s\\n' \"\${candidate}\"\n      return 0\n    fi\n  done\n\n  printf 'pwsh\\n'\n}\n`);

rmSync(path.join(root, 'scripts/_test-spawn-budget-fixture.ts'), { force: true });
write('scripts/autonomous-spawn-budget.test.ts', `import { describe, expect, it } from 'vitest';\nimport {\n  evaluateSpawnBudgetClass,\n  formatSpawnBudgetReport,\n  loadAutonomousSpawnBudget,\n} from '../docs/autonomous-spawn-budget.mjs';\nimport { repoRoot } from './_test-pwsh-helpers.js';\n\ndescribe('autonomous spawn budget policy after interposer retirement (Issue #462/#821)', () => {\n  const budgetLoad = loadAutonomousSpawnBudget(repoRoot);\n  expect(budgetLoad.ok).toBe(true);\n  const budget = budgetLoad.budget as Record<string, any>;\n  const classes = budget.classes as Record<string, Record<string, unknown>>;\n\n  it('retains the load-bearing budget classes as pure policy data', () => {\n    expect(budget.version).toBe('autonomous-spawn-budget/v1');\n    expect(classes['noop-shell']).toBeTruthy();\n    expect(classes['git-ao-read']).toBeTruthy();\n    expect(classes['denied-actions']).toBeTruthy();\n    expect(classes['supervisor-child-tick']).toBeTruthy();\n  });\n\n  it('accepts zero helper growth and spawn-free direct reads', () => {\n    expect(evaluateSpawnBudgetClass({ classId: 'noop-shell', budget, helperGrowth: 0 }).ok).toBe(true);\n    expect(evaluateSpawnBudgetClass({\n      classId: 'git-ao-read', budget, measuredPwshGuardSpawns: 0, commandCount: 6,\n    }).ok).toBe(true);\n  });\n\n  it('formats retained synthetic measurements', () => {\n    const report = formatSpawnBudgetReport({\n      budget,\n      measurements: {\n        'noop-shell': { helperGrowth: 0 },\n        'git-ao-read': { measuredPwshGuardSpawns: 0, commandCount: 6 },\n        'supervisor-child-tick': { measuredPwshGuardSpawns: 0, commandCount: 6 },\n      },\n    });\n    expect(report).toContain('noop-shell');\n    expect(report).toContain('git-ao-read');\n    expect(report).toContain('status=PASS');\n  });\n\n  it('still rejects a synthetic per-command fork amplifier', () => {\n    expect(evaluateSpawnBudgetClass({\n      classId: 'git-ao-read', budget, measuredPwshGuardSpawns: 6, commandCount: 6,\n    }).ok).toBe(false);\n  });\n});\n`);

const grep = spawnSync('git', [
  'grep', '-n', '-E',
  'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE|\\.ao/autonomous-real-binaries\\.json',
  '--',
  ':!docs/issues_drafts/**',
  ':!docs/migration_notes.md',
  ':!docs/declarations/**',
  ':!docs/issue_queue_index.md',
  ':!scripts/reachability-purge.manifest.json',
  ':!tests/external-output-references/captures/spawn-worktree-branch-operand-binding/integration-spawn-561-feat-issue-561.raw.txt',
  ':!.github/**',
], { cwd: root, encoding: 'utf8' });
if (![0, 1].includes(grep.status ?? 2)) throw new Error(grep.stderr);
if (grep.stdout.trim()) throw new Error(`retired references remain after residual migration:\n${grep.stdout}`);

rmSync(fileURLToPath(import.meta.url), { force: true });
console.log('Issue #821 residual interposer references migrated.');
