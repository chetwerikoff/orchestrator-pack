import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import { checkTypeScriptRuntimePolicy } from './check-typescript-runtime-policy.ts';

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

function fixtureInventory(workflowFiles: readonly string[] = []): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    issue: '#900',
    canonicalRuntime: {
      nodeMajor: 22,
      versionFile: 'scripts/toolchain/node-version.json',
      nativeArgvPrefix: ['--experimental-strip-types'],
    },
    classifications: {},
    historicalPathPrefixes: ['docs/archive', 'docs/declarations', 'docs/issues_drafts', 'scripts/fixtures'],
    workflowFiles,
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
      test: 'vitest run scripts/example.test.ts',
    },
    engines: { node: '22.x' },
  }, null, 2)}\n`);
  write(join(root, 'scripts/toolchain/node-version.json'), '{"schemaVersion":1,"nodeMajor":22}\n');
  write(join(root, 'AGENTS.md'), [
    '# Worker rules',
    '**Node 22-only TypeScript runtime:** use scripts/toolchain/node-version.json and package.json.engines.node.',
    'Do not add Node 20 actions/setup-node declarations.',
    '',
  ].join('\n'));
  write(join(root, 'scripts/toolchain/native-entrypoint-preflight.ts'), "export const ready: boolean = true;\n");
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
  write(join(root, 'scripts/example.ts'), [
    "import './toolchain/native-entrypoint-preflight.ts';",
    'export const answer: number = 42;',
    '',
  ].join('\n'));
  write(join(root, 'scripts/example.test.ts'), "import { answer } from './example.ts';\nvoid answer;\n");
  write(join(root, 'scripts/native.sh'), 'node --experimental-strip-types scripts/example.ts\n');
  write(join(root, 'scripts/lib/Invoke-TypeScriptCli.ts'), [
    '#!/usr/bin/env -S node --experimental-strip-types',
    "export const marker: string = 'launcher';",
    '',
  ].join('\n'));
  write(join(root, 'scripts/wrapper.ps1'), "$launcher = Join-Path $PSScriptRoot 'lib/Invoke-TypeScriptCli.ts'\n");
  return root;
}


function makeRealDeclareBinFixture(): string {
  const root = tempRoot('opk-real-declare-bin-');
  cpSync(join(repoRoot, 'plugins/_shared'), join(root, 'plugins/_shared'), { recursive: true });
  cpSync(join(repoRoot, 'plugins/ao-task-declaration'), join(root, 'plugins/ao-task-declaration'), { recursive: true });
  mkdirSync(join(root, 'scripts/toolchain'), { recursive: true });
  for (const name of ['native-entrypoint-preflight.ts', 'node-runtime-contract.mjs', 'node-runtime-contract.d.mts', 'node-version.json']) {
    cpSync(join(repoRoot, 'scripts/toolchain', name), join(root, 'scripts/toolchain', name));
  }
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'node_modules/@orchestrator-pack'), { recursive: true });
  symlinkSync(
    join(root, 'plugins/_shared'),
    join(root, 'node_modules/@orchestrator-pack/shared'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
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
  it('parses semantic versions and rejects unsupported runtimes before effects', () => {
    expect(parseNodeVersionMajor('v22.16.0')).toBe(22);
    expect(() => parseNodeVersionMajor('twenty-two')).toThrow('OPK_NODE_RUNTIME_VERSION_MALFORMED');

    let businessEffect = false;
    expect(() => {
      evaluateNodeRuntimeContract({ versionFileMajor: 22, engineText: '22.x', actualVersion: 'v20.19.0' });
      businessEffect = true;
    }).toThrow('OPK_NODE_RUNTIME_UNSUPPORTED');
    expect(businessEffect).toBe(false);
  });

  it('rejects malformed, non-22, and drifted declarations', () => {
    expect(() => evaluateNodeRuntimeContract({
      versionFileMajor: 22,
      engineText: '>=22',
      actualVersion: 'v22.16.0',
    })).toThrow('OPK_NODE_RUNTIME_ENGINE_DECLARATION_MALFORMED');
    expect(() => evaluateNodeRuntimeContract({
      versionFileMajor: 24,
      engineText: '24.x',
      actualVersion: 'v24.1.0',
    })).toThrow('OPK_NODE_RUNTIME_DECLARATION_UNSUPPORTED');
    expect(() => evaluateNodeRuntimeContract({
      versionFileMajor: 22,
      engineText: '24.x',
      actualVersion: 'v22.16.0',
    })).toThrow('OPK_NODE_RUNTIME_DECLARATION_DRIFT');
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
  it('accepts canonical native, bridge, and Vitest classifications', () => {
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

  it('rejects a type-only canonical preflight import that Node erases at runtime', () => {
    const root = makePolicyFixture();
    write(join(root, 'scripts/example.ts'), [
      "import type { ready } from './toolchain/native-entrypoint-preflight.ts';",
      'type RuntimeContract = typeof ready;',
      'export const answer: number = 42;',
      'void (0 as unknown as RuntimeContract);',
      '',
    ].join('\n'));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'node-contract'
      && violation.path === 'scripts/native.sh'
      && violation.message.includes('preflight'))).toBe(true);
  });

  it.each([
    [
      'reversed ordering',
      'node --experimental-strip-types scripts/example.ts && npm run check:node-major --silent',
    ],
    [
      'failure fallback',
      'npm run check:node-major --silent || node --experimental-strip-types scripts/example.ts',
    ],
  ])('rejects npm preflight bypass via %s', (_label, command) => {
    const root = makePolicyFixture();
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    manifest.scripts['gate-census-generate'] = command;
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'node-contract'
      && violation.path === 'package.json'
      && violation.message.includes('preflight'))).toBe(true);
  });

  it('rejects an unpreflighted TypeScript npm script in a workspace package', () => {
    const root = makePolicyFixture();
    const manifestPath = join(root, 'plugins/example/package.json');
    write(join(root, 'plugins/example/bin/run.ts'), [
      '#!/usr/bin/env -S node --experimental-strip-types',
      "import '../../../scripts/toolchain/native-entrypoint-preflight.ts';",
      '',
    ].join('\n'));
    write(manifestPath, `${JSON.stringify({
      name: '@orchestrator-pack/example',
      scripts: {
        bad: 'node --experimental-strip-types bin/run.ts',
      },
    }, null, 2)}\n`);
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'node-contract'
      && violation.path === 'plugins/example/package.json'
      && violation.message.includes('preflight'))).toBe(true);
  });

  it('requires the tracked worker rulebook to state the Node 22-only contract', () => {
    const root = makePolicyFixture();
    write(join(root, 'AGENTS.md'), '# Worker rules\n');
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'agent-runtime-contract'
      && violation.path === 'AGENTS.md')).toBe(true);
  });

  it('rejects a direct workspace runtime dependency', () => {
    const root = makePolicyFixture();
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest.devDependencies = { tsx: 'latest' };
    write(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(checkTypeScriptRuntimePolicy(root).violations.some((violation) => violation.rule === 'runtime-dependency')).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{not-json}\n'],
    ['drifted', '{"schemaVersion":1,"nodeMajor":24}\n'],
  ])('rejects a %s canonical version file', (_label, content) => {
    const root = makePolicyFixture();
    const path = join(root, 'scripts/toolchain/node-version.json');
    if (content === undefined) unlinkSync(path);
    else write(path, content);
    expect(checkTypeScriptRuntimePolicy(root).violations.some((violation) => violation.rule === 'node-contract')).toBe(true);
  });

  it.each([
    ['without a TypeScript launch', '      - run: node --version'],
    ['beside a forbidden launcher', '      - run: node --import tsx scripts/example.ts'],
  ])('checks every workflow Node declaration independently %s', (_label, runLine) => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/bad.yml';
    write(join(root, workflow), [
      'name: bad',
      'jobs:',
      '  test:',
      '    steps:',
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: '20' }",
      runLine,
      '',
    ].join('\n'));
    write(join(root, 'scripts/toolchain/typescript-launch-inventory.json'), fixtureInventory([workflow]));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) => violation.rule === 'workflow-node-version' && violation.path === workflow)).toBe(true);
  });

  it('rejects an unlisted workflow whose setup-node version is dynamic', () => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/dynamic.yml';
    write(join(root, workflow), [
      'name: dynamic',
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      '',
    ].join('\n'));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'workflow-node-version'
      && violation.path === workflow
      && violation.message.includes('literal'))).toBe(true);
  });

  it('does not accept comment-only setup-node text for a required workflow', () => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/comment-only.yml';
    write(join(root, workflow), [
      'name: comment-only',
      '# - uses: actions/setup-node@v4',
      "#   with: { node-version: '22' }",
      'jobs: {}',
      '',
    ].join('\n'));
    write(join(root, 'scripts/toolchain/typescript-launch-inventory.json'), fixtureInventory([workflow]));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'workflow-node-version'
      && violation.path === workflow
      && violation.message.includes('no live actions/setup-node'))).toBe(true);
  });

  it('rejects node-version outside the setup-node with mapping', () => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/env-version.yml';
    write(join(root, workflow), [
      'name: env-version',
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        env:',
      "          node-version: '22'",
      '',
    ].join('\n'));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'workflow-node-version'
      && violation.path === workflow
      && violation.message.includes('with.node-version'))).toBe(true);
  });

  it.each([
    [
      'quoted keys',
      [
        'name: quoted-keys',
        'jobs:',
        '  test:',
        '    steps:',
        '      - "uses": actions/setup-node@v4',
        '        "with":',
        '          "node-version": "20"',
        '',
      ].join('\n'),
    ],
    [
      'flow-style mapping',
      [
        'name: flow-style',
        'jobs:',
        '  test:',
        '    steps:',
        '      - { uses: actions/setup-node@v4, with: { node-version: "20" } }',
        '',
      ].join('\n'),
    ],
  ])('rejects Node 20 in an additional workflow using %s', (_label, source) => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/yaml-equivalent.yml';
    write(join(root, workflow), source);
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'workflow-node-version'
      && violation.path === workflow
      && violation.message.includes('received 20'))).toBe(true);
  });

  it('rejects node-version-file even when it points at the canonical declaration', () => {
    const root = makePolicyFixture();
    const workflow = '.github/workflows/version-file.yml';
    write(join(root, workflow), [
      'name: version-file',
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version-file: scripts/toolchain/node-version.json',
      '',
    ].join('\n'));
    const violations = checkTypeScriptRuntimePolicy(root).violations;
    expect(violations.some((violation) =>
      violation.rule === 'workflow-node-version'
      && violation.path === workflow
      && violation.message.includes('node-version-file'))).toBe(true);
  });

  it.each([
    ['static import', "import { value } from './dep.js';\nvoid value;\n"],
    ['static export', "export { value } from './dep.js';\n"],
    ['dynamic import', "void import('./dep.js');\n"],
    ['require call', "const { value } = require('./dep.js');\nvoid value;\n"],
  ])('rejects loader-dependent relative .js to .ts substitution in %s', (_label, source) => {
    const root = makePolicyFixture();
    write(join(root, 'scripts/dep.ts'), 'export const value = 1;\n');
    write(join(root, 'scripts/bad.ts'), source);
    expect(checkTypeScriptRuntimePolicy(root).violations.some((violation) =>
      violation.rule === 'runtime-import-specifier' && violation.path === 'scripts/bad.ts')).toBe(true);
  });

  it('accepts explicit relative TypeScript source extensions', () => {
    const root = makePolicyFixture();
    write(join(root, 'scripts/dep.ts'), 'export const value = 1;\n');
    write(join(root, 'scripts/good.ts'), "import { value } from './dep.ts';\nvoid value;\n");
    expect(checkTypeScriptRuntimePolicy(root).violations.filter((violation) =>
      violation.rule === 'runtime-import-specifier' && violation.path === 'scripts/good.ts')).toEqual([]);
  });
});


  it.skipIf(process.platform === 'win32').each([
    ['missing', undefined, 'OPK_NODE_RUNTIME_VERSION_FILE_MISSING'],
    ['drifted', '{"schemaVersion":1,"nodeMajor":24}\n', 'OPK_NODE_RUNTIME_DECLARATION_DRIFT'],
  ])('fails a real plugin bin before effects when the canonical version file is %s', async (_label, content, code) => {
    const root = makeRealDeclareBinFixture();
    const versionFile = join(root, 'scripts/toolchain/node-version.json');
    if (content === undefined) unlinkSync(versionFile);
    else write(versionFile, content);
    const marker = join(root, 'gh-effect.txt');
    const binDir = join(root, 'bin');
    const fakeGh = join(binDir, 'gh');
    write(fakeGh, `#!/usr/bin/env bash\nprintf effect > ${JSON.stringify(marker)}\nexit 99\n`);
    chmodSync(fakeGh, 0o755);

    const result = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        join(root, 'plugins/ao-task-declaration/bin/declare.ts'),
        '--issue', '900',
        '--declared-paths', 'scripts/example.ts',
        '--repo-root', root,
      ],
      cwd: root,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
      inheritParentEnv: true,
      timeoutMs: 30_000,
      allowEmptyStdout: true,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(code);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, 'docs/declarations'))).toBe(false);
  });

describe('representative real entrypoints', () => {
  it('executes toolchain, gate, supervised-child, and plugin-bin paths under Node 22', async () => {
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

    const plugin = await runNode(['--experimental-strip-types', 'plugins/ao-task-declaration/bin/declare.ts', '--help']);
    expect(plugin.ok).toBe(false);
    expect(plugin.stderr).toContain('Usage: ao-declare');
    expect(plugin.stderr).not.toContain('tsx');
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

  it('has one TypeScript launcher with declaration preflight and no PowerShell compatibility helper', () => {
    const launcherPath = join(repoRoot, 'scripts/lib/Invoke-TypeScriptCli.ts');
    const launcherSource = readFileSync(launcherPath, 'utf8');
    const preflight = launcherSource.indexOf('assertNodeRuntimeContract(invocation.repoRoot)');
    const targetImport = launcherSource.indexOf('await import(pathToFileURL(invocation.scriptPath).href)');
    expect(launcherSource.split(/\r?\n/u)[0]).toBe('#!/usr/bin/env -S node --experimental-strip-types');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(targetImport).toBeGreaterThan(preflight);
    expect(launcherSource).not.toContain('node:child_process');
    expect(launcherSource).not.toContain('--loader');
    expect(launcherSource).not.toContain('RUNNER_TOOL_CACHE');
    expect(launcherSource).not.toContain('OPK_VITEST_HARNESS');
    expect(existsSync(join(repoRoot, 'scripts/lib/Invoke-TypeScriptCli.ps1'))).toBe(false);
    expect(existsSync(join(repoRoot, 'scripts/toolchain', ['typescript', 'loader.mjs'].join('-')))).toBe(false);
  });

  it('forwards argv through the TypeScript launcher and reaches direct-execution target code', async () => {
    const targetRoot = tempRoot('opk-typescript-cli-target-');
    const target = join(targetRoot, 'target.ts');
    write(target, [
      "const payload: { argv: string[]; direct: boolean } = {",
      '  argv: process.argv.slice(2),',
      '  direct: process.argv[1] === import.meta.filename,',
      '};',
      'process.stdout.write(`${JSON.stringify(payload)}\n`);',
      '',
    ].join('\n'));
    const launched = await runNode([
      '--experimental-strip-types',
      'scripts/lib/Invoke-TypeScriptCli.ts',
      '--script', target,
      '--', 'alpha', '--beta', 'two words',
    ]);
    expect(launched.ok, launched.stderr || launched.error).toBe(true);
    expect(JSON.parse(launched.stdout)).toEqual({
      argv: ['alpha', '--beta', 'two words'],
      direct: true,
    });
  });

  it('rejects unsupported launcher targets before importing target code', async () => {
    const targetRoot = tempRoot('opk-typescript-cli-invalid-');
    const marker = join(targetRoot, 'effect.txt');
    const target = join(targetRoot, 'target.js');
    write(target, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const launched = await runNode([
      '--experimental-strip-types',
      'scripts/lib/Invoke-TypeScriptCli.ts',
      '--script', target,
    ]);
    expect(launched.ok).toBe(false);
    expect(launched.stderr).toContain('OPK_TYPESCRIPT_CLI_TARGET_EXTENSION_UNSUPPORTED');
    expect(existsSync(marker)).toBe(false);
  });
});
