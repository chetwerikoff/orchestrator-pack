import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEAF_RELATIVE_PATHS = [
  'scripts/graphify/build-graph.ps1',
  'scripts/graphify/refresh-graph.ps1',
  'scripts/graphify/query-graph.ps1',
  'scripts/graphify/query-graph.mjs',
] as const;

const ENFORCEMENT_RELATIVE_PATH = 'scripts/graphify/lib/Resolve-GraphifyEnv.ps1';

function repoRoot(): string {
  return resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));
}

function nonCommentLines(text: string): Array<{ lineNumber: number; text: string }> {
  const lines = text.split(/\r?\n/u);
  const result: Array<{ lineNumber: number; text: string }> = [];
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (inBlockComment) {
      if (line.includes('#>')) inBlockComment = false;
      continue;
    }
    if (line.includes('<#')) {
      if (!line.includes('#>')) inBlockComment = true;
      continue;
    }
    if (/^\s*#/u.test(line) || /^\s*\/\//u.test(line)) continue;
    result.push({ lineNumber: index + 1, text: line });
  }
  return result;
}

export function scanGraphifyNoInstaller(root = repoRoot()): string[] {
  const violations: string[] = [];
  for (const rel of LEAF_RELATIVE_PATHS) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      violations.push(`${rel} :: missing in-scope file`);
      continue;
    }
    for (const entry of nonCommentLines(readFileSync(path, 'utf8'))) {
      if (/&\s*\$exe\b/u.test(entry.text)) {
        violations.push(
          `${rel}:${entry.lineNumber}: invokes the graphify executable directly, bypassing Invoke-GraphifyCommand: ${entry.text.trim()}`,
        );
      }
      if (/\binstall\b/iu.test(entry.text)) {
        violations.push(
          `${rel}:${entry.lineNumber}: contains the word 'install' outside a comment: ${entry.text.trim()}`,
        );
      }
    }
  }

  const enforcementPath = join(root, ENFORCEMENT_RELATIVE_PATH);
  if (!existsSync(enforcementPath)) {
    violations.push(`${ENFORCEMENT_RELATIVE_PATH} :: missing enforcement file`);
  } else {
    const enforcementText = readFileSync(enforcementPath, 'utf8');
    if (!/ValidateSet\('extract',\s*'update'\)/u.test(enforcementText)) {
      violations.push(`${ENFORCEMENT_RELATIVE_PATH} :: allowed-subcommand ValidateSet must be exactly ('extract', 'update')`);
    }
    if (!/\binstall\b/u.test(enforcementText)) {
      violations.push(`${ENFORCEMENT_RELATIVE_PATH} :: runtime guard must reject arguments matching an install-family pattern`);
    }
  }
  return violations;
}

function main(): number {
  const violations = scanGraphifyNoInstaller();
  if (violations.length > 0) {
    process.stdout.write('[FAIL] graphify no-installer scan (Issue #833 AC#1/AC#7):\n');
    for (const violation of violations) {
      process.stdout.write(`  - ${violation}\n`);
    }
    return 1;
  }
  process.stdout.write('[PASS] graphify wrapper scripts never invoke graphify install / <platform> install (Issue #833 AC#1/AC#7)\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
