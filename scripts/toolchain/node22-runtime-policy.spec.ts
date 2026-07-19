import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';
import {
  evaluateNodeRuntimeContract,
  parseNodeVersionMajor,
} from './node-runtime-contract.mjs';
import { checkTypeScriptRuntimePolicy } from './check-typescript-runtime-policy.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

function commandExists(name: string): boolean {
  const pathValue = process.env.PATH ?? '';
  const candidates = process.platform === 'win32'
    ? [name, `${name}.exe`, `${name}.cmd`]
    : [name];
  return pathValue.split(delimiter).some((directory) =>
    directory.length > 0 && candidates.some((candidate) => existsSync(join(directory, candidate))));
}

const hasPowerShell = commandExists('pwsh');

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixtureInventory(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    issue: '#900',
    canonicalRuntime: {
      nodeMajor: 22,
      versionFile: 'package.json',
      nativeArgvPrefix: ['--experimental-strip-types'],
    },
    classifications: {},
    historicalPathPrefixes: ['docs/archive', 'docs/declarations', 'docs/issues_drafts', 'scripts/fixtures'],
    requiredLiveSurfaces: [],
  }, null, 2)}\n`;
}

function makePolicyFixture(): string {
  const root = tempRoot('opk-node22-policy-');
  write(join(root, 'package.json'), `${JSON.stringify({
    type: 'module',
    scripts: {
      'check:node-major': 'node scripts/toolchain/check-node-major.mjs',
      smoke: 'npm run check:node-major --silent && node --experimental-strip-types scripts/example.ts',
      test: 'npm run check:node-major --silent && vitest run scripts/example.test.ts',
    },
    engines: { node: '22.x' },
  }, null, 2)}\n`);
  write(join(root, 'tsconfig.base.json'), `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
    },
  }, null, 2)}\n`);
  write(join(root, 'scripts/toolchain/typescript-launch-inventory.json'), fixtureInventory());
  write(join(root, 'scripts/example.ts'), 'export const answer: number = 42;\n');
  write(join(root, 'scripts/native.sh'), 'node --experimental-strip-types scripts/example.ts\n');
  write(join(root, 'scripts/wrapper.ps1'), '$args = Get-OpkTypeScriptNodeArguments -ScriptPath scripts/example.ts\n');
  return root;
}

function compileErasableFixture(name: string): readonly ts.Diagnostic[] {
  const source = readFileSync(join(repoRoot, 'scripts/toolchain/fixtures/erasable', `${name}.ts.txt`), 'utf8');
  const root = tempRoot('opk-erasable-');
  const path = join(root, `${name}.mts`);
  write(path, source);
  const program = ts.createProgram({
    rootNames: [path],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
    },
  });
  return ts.getPreEmitDiagnostics(program);
}

async function runNode(args: readonly string[], timeoutMs = 30_000) {
  return runProcess({
    command: process.execPath,
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    timeoutMs,
    allowEmptyStdout: true,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Node 22 runtime contract', () => {
  it('parses semantic versions and rejects malformed or unsupported versions before effects', () => {
    expect(parseNodeVersionMajor('v22.16.0')).toBe(22);
    expect(() => parseNodeVersionMajor('twenty-two')).toThrow('OPK_NODE_RUNTIME_VERSION_MALFORMED');

    let businessEffect = false;
    expect(() => {
      evaluateNodeRuntimeContract({ engineText: '22.x', actualVersion: 'v20.19.0' });
      businessEffect = true;
    }).toThrow('OPK_NODE_RUNTIME_UNSUPPORTED');
    expect(businessEffect).toBe(false);
  });

  it('rejects malformed and non-22 declarations', () => {
    expect(() => evaluateNodeRuntimeContract({
      engineText: '>=22',
      actualVersion: 'v22.16.0',
    })).toThrow('OPK_NODE_RUNTIME_DECLARATION_MALFORMED');
    expect(() => evaluateNodeRuntimeContract({
      engineText: '24.x',
      actualVersion: 'v24.1.0',
    })).toThrow('OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED');
  });
});

describe('erasable TypeScript dialect', () => {
  it('accepts typed JavaScript-style modules', () => {
    expect(compileErasableFixture('positive')).toEqual([]);
  });

  it.each(['runtime-enum', 'parameter-property', 'runtime-namespace', 'import-assignment'])(
    'rejects %s',
    (name) => {
      const messages = compileErasableFixture(name)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      expect(messages.some((message) => message.includes('erasableSyntaxOnly'))).toBe(true);
    },
  );
});

describe('launch inventory and fail-closed policy', () => {
  it('accepts the canonical native, bridge, and Vitest classifications', () => {
    const report = checkTypeScriptRuntimePolicy(makePolicyFixture());
    expect(report.violations).toEqual([]);
    expect(new Set(report.inventory.map((entry) => entry.classification))).toEqual(new Set([
      'native-node-22',
      'powershell-bridge',
      'test-framework-owned',
    ]));
  });

  it.each([
    ['custom loader', 'scripts/bad.sh', 'node --loader scripts/toolchain/custom-loader.mjs scripts/example.ts\n', 'runtime-loader'],
    ['direct launch', 'scripts/bad.sh', 'node scripts/example.ts\n', 'direct-typescript-launch'],
    [
      'Node-major launch branch',
      'scripts/bad.ps1',
      "if ($nodeMajor -ge 22) { $args = @('--experimental-strip-types') } else { $args = @('--loader', 'fallback.mjs') }\n",
      'node-major-branch',
    ],
    ['runtime enum', 'scripts/bad.ts', 'export enum Bad { Value = 1 }\n', 'non-erasable-syntax'],
  ])('rejects a %s mutation', (_label, path, source, rule) => {
    const root = makePolicyFixture();
    write(join(root, path), source);
    expect(checkTypeScriptRuntimePolicy(root).violations.some((violation) => violation.rule === rule)).toBe(true);
  });

  it('rejects runtime dependencies and version drift mutations', () => {
    const root = makePolicyFixture();
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest.devDependencies = { tsx: 'latest' };
    write(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    manifest.engines = { node: '20.x' };
    write(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const rules = new Set(checkTypeScriptRuntimePolicy(root).violations.map((violation) => violation.rule));
    expect(rules.has('runtime-dependency')).toBe(true);
    expect(rules.has('node-contract')).toBe(true);
  });
});

describe('representative real entrypoints', () => {
  it('executes toolchain, gate, and supervised-child-facing paths under Node 22', async () => {
    const nodeCheck = await runNode(['scripts/toolchain/check-node-major.mjs']);
    expect(nodeCheck.ok, nodeCheck.stderr).toBe(true);
    expect(nodeCheck.stdout).toContain('Node.js 22.');

    const smoke = await runNode(['--experimental-strip-types', 'scripts/typescript-smoke.ts']);
    expect(smoke.ok, smoke.stderr).toBe(true);

    const gateRoot = tempRoot('opk-node22-gate-');
    write(join(gateRoot, 'scripts/check-example.ps1'), "Write-Output 'ok'\n");
    write(join(gateRoot, 'scripts/example.ps1'), "Write-Output 'example'\n");
    write(join(gateRoot, 'scripts/verify.ps1'), [
      "Test-CommandVersion -Command 'node'",
      "Test-ContractMarkers 'scripts/example.ps1'",
      "Write-Check 'example'",
      "$requiredFiles = @('scripts/example.ps1')",
      'foreach ($file in $requiredFiles) { }',
      '',
    ].join('\n'));
    write(join(gateRoot, 'scripts/check-reusable.ps1'), [
      'if ($AllowNoGit) { exit 0 }',
      '$allowedPathPatterns = @()',
      '$allowedRootPatterns = @()',
      '$exceptionPatterns = @()',
      '$forbiddenPatterns = @()',
      "Write-Output 'git not found; cannot inspect tracked files.'",
      'git rev-parse --is-inside-work-tree',
      'git ls-files',
      'if ($Violations.Count -gt 0) { exit 1 }',
      '',
    ].join('\n'));
    for (const args of [
      ['init', '-b', 'main'],
      ['add', '.'],
      ['-c', 'user.name=Issue 900 Test', '-c', 'user.email=issue-900@example.invalid', 'commit', '-m', 'fixture'],
    ]) {
      const result = await runProcess({
        command: 'git',
        args,
        cwd: gateRoot,
        inheritParentEnv: true,
        allowEmptyStdout: true,
      });
      expect(result.ok, result.stderr).toBe(true);
    }
    const head = await runProcess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: gateRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });
    expect(head.ok, head.stderr).toBe(true);
    const gate = await runNode([
      '--experimental-strip-types',
      'scripts/gate-runner/census-generator.ts',
      '--repo-root', gateRoot,
      '--base-ref', head.stdout.trim(),
    ]);
    expect(gate.ok, gate.stderr).toBe(true);
    expect(JSON.parse(gate.stdout)).toMatchObject({ baseCommitSha: head.stdout.trim() });

    const runner = await runNode(['--experimental-strip-types', 'scripts/pack-review-runner.ts', 'help']);
    expect(runner.ok, runner.stderr).toBe(true);
    expect(runner.stdout).toContain('Pack-owned review runner');
  }, 60_000);

  it.skipIf(!hasPowerShell)('executes the Wave B PowerShell bridge through the canonical runtime preflight', async () => {
    const outputRoot = tempRoot('opk-node22-bridge-');
    const artifact = join(outputRoot, 'sanctioned-worker-kills.json');
    const bridge = await runProcess({
      command: 'pwsh',
      args: [
        '-NoProfile',
        '-File',
        'scripts/record-sanctioned-worker-kill.ps1',
        '-SessionId',
        'issue-900-smoke',
        '-Path',
        artifact,
      ],
      cwd: repoRoot,
      inheritParentEnv: true,
      timeoutMs: 30_000,
      allowEmptyStdout: false,
    });
    expect(bridge.ok, bridge.stderr || bridge.error).toBe(true);
    expect(JSON.parse(bridge.stdout)).toMatchObject({
      healthy: true,
      records: [{ sessionId: 'issue-900-smoke' }],
    });
    expect(existsSync(artifact)).toBe(true);
  }, 30_000);

  it('has one bridge argv shape and no compatibility loader reference', () => {
    const bridgeSource = readFileSync(join(repoRoot, 'scripts/lib/Invoke-TypeScriptCli.ps1'), 'utf8');
    const preflight = bridgeSource.indexOf('Invoke-OpkNodeRuntimePreflight -RepoRoot');
    const nativeArgv = bridgeSource.indexOf("return @('--experimental-strip-types', $ScriptPath)");
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(nativeArgv).toBeGreaterThan(preflight);
    expect(bridgeSource).not.toContain('--loader');
    expect(existsSync(join(repoRoot, 'scripts/toolchain', ['typescript', 'loader.mjs'].join('-')))).toBe(false);
  });
});
