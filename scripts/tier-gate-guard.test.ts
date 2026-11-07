// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTierGateGuard, checkWorkerSafetyFloor, formatTierGatePassMessage, parseComplexityTierFence } from './lib/tier-gate-core.ts';
import { canonicalizeEntry } from './pr-scope-declaration.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { checkContractEvidence } from './contract-evidence-validator.mjs';
import { runContractEvidenceReverify } from './lib/contract-evidence-reverify.ts';
import { isPrHeadNetworkSandboxAvailable } from './lib/reverify-sandbox.ts';
import { captureBoundIssueSnapshot } from './lib/reverify-bound-issue-snapshot.ts';

const valid = `## Prerequisite
None.

## Goal
Ship it.

~~~behavior-kind
action-producing
~~~

~~~complexity-tier
tier: T2
failure-type: local-behavior
size: single-component-design-judgment
~~~

~~~positive-outcome
asserts: works
input: realistic
~~~

## Binding surface
Current component.

## Files in scope
- scripts/**

## Files out of scope
- vendor/**

~~~denylist
packages/core/**
vendor/**
~~~

~~~allowed-roots
scripts/**
~~~

## Acceptance criteria
1. Works.

## Upgrade-safety check
No duplicate path.

~~~smoke-test-plan
scenarios:
  - action: run | expected: pass
~~~

## Verification
- AC1: run.

~~~contract-evidence
none
~~~
`.replaceAll('~~~', String.fromCharCode(96).repeat(3));

describe('current substantive Issue floor', () => {
  it('accepts a complete T2 action-producing Issue body', () => {
    const result = checkTierGateGuard(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(parseComplexityTierFence(valid)).toMatchObject({ kind: 'tier-fence', tier: 'T2' });
  });

  it('rejects an unreadable smoke plan in the real --text CLI and accepts its indented child', () => {
    const invalidBody = valid.replace(
      '  - action: run | expected: pass',
      '- action: run\nexpected: pass',
    );
    const runGuard = (body: string) => runProcessSync({
      command: process.execPath,
      args: [
        '--experimental-strip-types',
        fileURLToPath(new URL('./tier-gate-guard.ts', import.meta.url)),
        '--text',
        body,
      ],
      inheritParentEnv: true,
    });

    const invalid = runGuard(invalidBody);
    expect(invalid.error).toBeUndefined();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain(
      'tier-gate guard: smoke-test-plan must list at least one scenario with action and expected result, or declare not-applicable with reason',
    );
    expect(invalid.stdout).not.toContain('tier-gate guard: PASS');

    const corrected = runGuard(invalidBody.replace('\nexpected: pass', '\n  expected: pass'));
    expect(corrected.error).toBeUndefined();
    expect(corrected.exitCode).toBe(0);
    expect(corrected.stdout).toContain('tier-gate guard: PASS T2');
  });

  it('does not confuse narrative run_check() with a run ID, but rejects executable/structured runtime IDs', () => {
    const prose = valid
      .replace('## Goal\nShip it.', '## Goal\nThe named function run_check() documents the API.')
      .replace(
        '  - action: run | expected: pass',
        '  - action: Describe the function run_check() | expected: run_check() is documented',
      );
    const baseRun = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', fileURLToPath(new URL('./tier-gate-guard.ts', import.meta.url)), '--text', prose],
      inheritParentEnv: true,
    });
    const noNameRun = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', fileURLToPath(new URL('./tier-gate-guard.ts', import.meta.url)), '--text',
        prose.replaceAll('run_check()', 'the named function')],
      inheritParentEnv: true,
    });
    expect(baseRun.exitCode).toBe(0);
    expect(noNameRun.exitCode).toBe(0);
    expect(baseRun.stdout).toContain('tier-gate guard: PASS T2');
    expect(checkTierGateGuard(prose).ok).toBe(true);

    for (const line of [
      '  - action: resume run_123abcd | expected: complete',
      '  - action: run run_123abcd | expected: complete',
      '  - action: node scripts/report-run.mjs run_123abcd | expected: complete',
      '  - action: node scripts/check.mjs --session=run_abc12345 | expected: complete',
      '  - action: inspect output | expected: run_abc12345',
      '  - action: inspect result | expected: runtime-id: term_88da12',
      '  - action: inspect --msg-id=msg_f312ba | expected: complete',
    ]) {
      const withId = valid.replace('  - action: run | expected: pass', line);
      const result = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', fileURLToPath(new URL('./tier-gate-guard.ts', import.meta.url)), '--text', withId],
        inheritParentEnv: true,
      });
      expect(result.exitCode, line).toBe(1);
      expect(result.stderr).toContain('replace with stable non-session-bound inputs and rerun the guard');
    }
    expect(checkTierGateGuard(valid.replace('  - action: run | expected: pass',
      '  - action: resume run_123abcd | expected: complete')).ok).toBe(false);
  });

  it.each(['baseline', 'dynamic-commonjs', 'nested-root'] as const)(
    'binds target NEW evidence and independent proof to a synthetic selected card without admitting other commands: %s', (mode) => {
    const temp = mkdtempSync(join(tmpdir(), 'opk2751-'));
    const packRoot = fileURLToPath(new URL('../', import.meta.url));
    const projectId = 'synthetic-2751';
    const repository = 'example/synthetic-2751';
    const targetRoot = join(temp, 'target');
    const env = { ...process.env, OPK_PROJECT_ID: projectId, XDG_CONFIG_HOME: join(temp, 'config'), HOME: temp };
    const cardPath = join(env.XDG_CONFIG_HOME, 'orchestrator-pack', 'projects', projectId + '.json');
    const producerDir = 'tests/fixtures/contract-evidence-reverify/producers';
    const proofCommand = 'node ' + producerDir + '/genuine-new-proof.mjs';
    const boundaryCommand = 'node scripts/verify-boundary.mjs';
    const runGit = (...args: string[]) => {
      const output = runProcessSync({ command: 'git', args, cwd: targetRoot, inheritParentEnv: true });
      if (!output.ok) throw new Error('synthetic git setup failed: ' + String(output.stderr || output.error));
    };
    try {
      mkdirSync(targetRoot, { recursive: true });
      mkdirSync(join(targetRoot, producerDir), { recursive: true });
      mkdirSync(join(targetRoot, 'scripts'), { recursive: true });
      for (const filename of ['genuine-new-proof.mjs', 'emit-reverify-status.mjs', 'echo-expected.mjs', 'structured-value.mjs']) {
        copyFileSync(join(packRoot, producerDir, filename), join(targetRoot, producerDir, filename));
      }
      copyFileSync(join(packRoot, producerDir, 'emit-reverify-status.mjs'), join(targetRoot, 'scripts', 'verify-boundary.mjs'));
      // Both trusted scripts read checkout-local input; only W's read-only
      // input is modified, not the P/W executable/dependency closure.
      const observedProducer = mode === 'dynamic-commonjs' ? [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "const worker = './worker.cjs';",
        'process.stdout.write(require(worker));',
        '',
      ].join('\n') : [
        "import { readProof } from './proof-input.mjs';",
        "process.stdout.write(readProof());",
        '',
      ].join('\n');
      const dependency = "import { readFileSync } from 'node:fs';\nexport const readProof = () => readFileSync('inputs/proof.json', 'utf8');\n";
      writeFileSync(join(targetRoot, 'scripts', 'verify-boundary.mjs'), observedProducer);
      writeFileSync(join(targetRoot, producerDir, 'emit-reverify-status.mjs'), observedProducer);
      writeFileSync(join(targetRoot, 'scripts', 'proof-input.mjs'), dependency);
      writeFileSync(join(targetRoot, producerDir, 'proof-input.mjs'), dependency);
      if (mode === 'dynamic-commonjs') {
        for (const directory of ['scripts', producerDir]) {
          writeFileSync(join(targetRoot, directory, 'worker.cjs'),
            'module.exports = ' + JSON.stringify(JSON.stringify({ 'reverify-status': 'primary-only' })) + ';\n');
        }
      }
      mkdirSync(join(targetRoot, 'inputs'), { recursive: true });
      writeFileSync(join(targetRoot, 'inputs', 'proof.json'), JSON.stringify({ 'reverify-status': 'primary-only' }));
      const manifestPath = 'tests/external-output-references/capture-manifest.json';
      mkdirSync(dirname(join(targetRoot, manifestPath)), { recursive: true });
      writeFileSync(join(targetRoot, manifestPath), JSON.stringify({
        version: 1, corpusRoot: 'tests/external-output-references', entries: {},
      }));
      runGit('init');
      runGit('remote', 'add', 'origin', 'https://github.com/' + repository + '.git');
      runGit('add', '.');
      runGit('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'synthetic');
      const prHeadResult = runProcessSync({
        command: 'git', args: ['rev-parse', 'HEAD'], cwd: targetRoot, inheritParentEnv: true,
      });
      expect(prHeadResult.ok).toBe(true);
      const primaryHeadSha = prHeadResult.stdout.trim();
      const worktreeRoot = join(temp, 'review-target');
      let reviewRoot = worktreeRoot;
      runGit('worktree', 'add', '--detach', worktreeRoot, primaryHeadSha);
      const gitW = (...args: string[]) => {
        const result = runProcessSync({ command: 'git', args, cwd: worktreeRoot, inheritParentEnv: true });
        if (!result.ok) throw new Error('PR worktree Git failed: ' + String(result.stderr || result.error));
      };
      const headW = () => {
        const result = runProcessSync({
          command: 'git', args: ['rev-parse', 'HEAD'], cwd: worktreeRoot, inheritParentEnv: true,
        });
        if (!result.ok) throw new Error('PR HEAD unreadable');
        return result.stdout.trim();
      };
      writeFileSync(join(reviewRoot, 'inputs', 'proof.json'), JSON.stringify({ 'reverify-status': 'verified' }));
      gitW('add', 'inputs/proof.json');
      gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'PR input only');
      if (mode === 'dynamic-commonjs') {
        for (const directory of ['scripts', producerDir]) {
          writeFileSync(join(reviewRoot, directory, 'worker.cjs'),
            'module.exports = ' + JSON.stringify(JSON.stringify({ 'reverify-status': 'verified' })) + ';\n');
        }
        gitW('add', 'scripts/worker.cjs', producerDir + '/worker.cjs');
        gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'PR changes runtime CommonJS dependency');
      }
      if (mode === 'nested-root') {
        writeFileSync(join(worktreeRoot, '.gitignore'), 'nested-w/\n');
        gitW('add', '.gitignore');
        gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'ignore nested live inputs');
        reviewRoot = join(worktreeRoot, 'nested-w');
        for (const relative of ['scripts/verify-boundary.mjs', 'scripts/proof-input.mjs',
          producerDir + '/genuine-new-proof.mjs', producerDir + '/emit-reverify-status.mjs',
          producerDir + '/proof-input.mjs', 'inputs/proof.json']) {
          mkdirSync(dirname(join(reviewRoot, relative)), { recursive: true });
          copyFileSync(join(worktreeRoot, relative), join(reviewRoot, relative));
        }
        expect(existsSync(join(reviewRoot, '.git'))).toBe(false);
        const clean = runProcessSync({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], cwd: reviewRoot });
        expect(clean.ok).toBe(true);
        expect(clean.stdout).toBe('');
        expect(runProcessSync({ command: 'git', args: ['check-ignore', 'inputs/proof.json'], cwd: reviewRoot }).ok).toBe(true);
      }
      const prHeadSha = headW();
      expect(prHeadSha).not.toBe(primaryHeadSha);
      expect(readFileSync(join(targetRoot, 'inputs', 'proof.json'), 'utf8')).toContain('primary-only');
      expect(readFileSync(join(reviewRoot, 'inputs', 'proof.json'), 'utf8')).toContain('verified');
      expect(readFileSync(join(targetRoot, 'scripts', 'verify-boundary.mjs')))
        .toEqual(readFileSync(join(reviewRoot, 'scripts', 'verify-boundary.mjs')));
      mkdirSync(dirname(cardPath), { recursive: true });
      const card = {
        projectId, repository, primaryRoot: targetRoot, defaultBranch: 'main',
        orcaWorkspacePattern: 'synthetic/workspaces/',
        orchestratorTitlePattern: 'synthetic orchestrator',
        browserGpt: { projectUrl: 'https://chatgpt.com/g/synthetic-2751/project' },
        contractEvidenceProducer: { name: 'target-status', boundaryCommand },
      };
      const putCard = (value: object) => writeFileSync(cardPath, JSON.stringify(value));
      putCard(card);
      const tick = String.fromCharCode(96).repeat(3);
      const makeIssue = (producer: string, producerCommand = boundaryCommand, proof = proofCommand) => valid
        .replace('1. Works.', ['1. Works.', '', tick + 'producer-emission',
          'producer: ' + producer,
          'datum: reverify-status',
          'expected: verified',
          'proof-command: ' + proof,
          'producer-command: ' + producerCommand, tick].join('\n'))
        .replace(tick + 'contract-evidence\nnone\n' + tick, [
          tick + 'contract-evidence',
          'binding: target-reported verification status',
          'binding-id: ' + producer + ':reverify-status:verified',
          'producer: ' + producer,
          'evidence: NEW(produced-by AC#1)',
          tick,
        ].join('\n'));

      const targetIssue = makeIssue('target-status');
      const floorOptions = { repoRoot: packRoot, projectId, env };
      expect(checkTierGateGuard(targetIssue, floorOptions)).toMatchObject({ ok: true, errors: [] });
      // Validate through the actual tier-gate evidence consumer, not the governed legacy entrypoint.
      expect(checkContractEvidence(targetIssue, floorOptions)).toMatchObject({ ok: true, errors: [], skipped: false });

      const cli = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', join(packRoot, 'scripts', 'tier-gate-guard.ts'),
          '--project', projectId, '--repo-root', packRoot, '--text', targetIssue],
        env, inheritParentEnv: true,
      });
      expect(cli.exitCode, cli.stderr).toBe(0);
      expect(cli.stdout).toContain('tier-gate guard: PASS T2');

      const reverify = (body: string, extra: {
        forceProducerUnreachable?: boolean; prHeadSha?: string | null; prModifiedPaths?: string[];
      } = {}) =>
        runContractEvidenceReverify({
          repoRoot: packRoot, trustedBaseRoot: targetRoot, reviewTargetRoot: reviewRoot,
          manifestPath, boundSnapshotBody: body, explicitIssueNumber: 2751,
          prHeadSha, projectId, env, prModifiedPaths: mode === 'dynamic-commonjs'
            ? ['inputs/proof.json', 'scripts/worker.cjs', producerDir + '/worker.cjs'] : ['inputs/proof.json'], ...extra,
        });
      const verified = reverify(targetIssue);
      expect(verified).toMatchObject({ candidateOnly: true, neverBlocks: true, runOutcome: 'rows-evaluated' });
      expect(reverify(targetIssue, { prHeadSha: 'a'.repeat(40) }).rows[0])
        .toMatchObject({ status: 'unverified', reason: 'producer-unreachable', producerVerified: false });
      expect(reverify(targetIssue, { prHeadSha: null }).rows[0])
        .toMatchObject({ status: 'unverified', reason: 'producer-unreachable', producerVerified: false });
      if (mode === 'baseline' && isPrHeadNetworkSandboxAvailable()) {
        expect(verified.rows[0]).toMatchObject({ status: 'verified', verificationMode: 'live', producerVerified: true });
      } else if (mode === 'baseline') {
        expect(verified.rows[0]).toMatchObject({ status: 'unverified', reason: 'producer-unreachable' });
      }

      // Exercise the production CLI selector independently of OPK_PROJECT_ID; a library-only call misses this handoff.
      const snapshotStore = join(temp, 'bound-snapshots');
      const captured = captureBoundIssueSnapshot({
        projectId, prNumber: 2769, prHeadSha, issueNumber: 2751,
        issueBody: targetIssue, storeDirOverride: snapshotStore,
      });
      const changedPathsFile = join(temp, 'changed-paths.txt');
      writeFileSync(changedPathsFile, mode === 'dynamic-commonjs'
        ? 'inputs/proof.json\nscripts/worker.cjs\n' + producerDir + '/worker.cjs\n' : '', 'utf8');
      const cliEnv: NodeJS.ProcessEnv = { ...env, OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR: snapshotStore };
      delete cliEnv.OPK_PROJECT_ID;
      const invokeCli = (sha: string | null = prHeadSha, snapshotPath = captured.snapshotPath, extraArgs: string[] = []) => runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', join(packRoot, 'scripts', 'invoke-contract-evidence-reverify.ts'),
          '--repo-root', packRoot, '--trusted-base-root', targetRoot, '--review-target-root', reviewRoot,
          '--manifest-path', manifestPath, '--snapshot-file', snapshotPath,
          '--bound-snapshot-pr-number', '2769', '--bound-snapshot-issue-number', '2751',
          '--project-id', projectId, '--explicit-issue', '2751',
          ...(sha === null ? [] : ['--pr-head-sha', sha]),
          '--changed-paths-file', changedPathsFile, ...extraArgs],
        env: cliEnv, inheritParentEnv: false,
      });
      const cliReverify = invokeCli();
      expect(cliReverify.exitCode, cliReverify.stderr).toBe(0);
      const cliResult = JSON.parse(cliReverify.stdout);
      expect(cliResult).toMatchObject({ candidateOnly: true, neverBlocks: true, runOutcome: 'rows-evaluated' });
      expect(cliResult.rows).toHaveLength(1);
      if (mode !== 'baseline') {
        for (const result of [verified, cliResult]) {
          expect(result).toMatchObject({ candidateOnly: true, neverBlocks: true });
          expect(result.rows[0], mode).toMatchObject({ status: 'unverified', producerVerified: false });
          if (mode === 'nested-root') expect(result.rows[0].reason).toBe('producer-unreachable');
        }
        return;
      }
      expect(cliResult.rows[0].reason).not.toBe('unsupported-producer');
      if (isPrHeadNetworkSandboxAvailable()) {
        expect(cliResult.rows[0]).toMatchObject({ status: 'verified', verificationMode: 'live', producerVerified: true });
      } else {
        expect(cliResult.rows[0]).toMatchObject({ status: 'unverified', reason: 'producer-unreachable' });
      }
      // Distinct exact-SHA W is required for both the library and the CLI.
      const assertUnverified = (row: ReturnType<typeof reverify>['rows'][number]) => {
        expect(row?.status).toBe('unverified');
        expect(row?.producerVerified).not.toBe(true);
      };
      const assertBothUnverified = (body = targetIssue) => {
        // Each independent Issue-body fixture gets a distinct real bound head;
        // never replace an immutable snapshot for the same PR/head identity.
        gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test',
          'commit', '--allow-empty', '-m', 'independent negative snapshot');
        const sha = headW();
        assertUnverified(reverify(body, { prHeadSha: sha }).rows[0]);
        const snapshot = captureBoundIssueSnapshot({ projectId, prNumber: 2769, prHeadSha: sha,
          issueNumber: 2751, issueBody: body, storeDirOverride: snapshotStore });
        const output = invokeCli(sha, snapshot.snapshotPath);
        expect(output.exitCode, output.stderr).toBe(0);
        const result = JSON.parse(output.stdout);
        expect(result).toMatchObject({ candidateOnly: true, neverBlocks: true });
        assertUnverified(result.rows[0]);
      };
      assertUnverified(reverify(targetIssue, { prModifiedPaths: ['scripts/verify-boundary.mjs'] }).rows[0]);
      writeFileSync(changedPathsFile, 'scripts/verify-boundary.mjs\n');
      const modifiedCli = invokeCli();
      expect(modifiedCli.exitCode, modifiedCli.stderr).toBe(0);
      assertUnverified(JSON.parse(modifiedCli.stdout).rows[0]);
      writeFileSync(changedPathsFile, 'inputs/proof.json\n');

      gitW('checkout', '--detach', primaryHeadSha);
      assertUnverified(reverify(targetIssue).rows[0]);
      const wrongHeadCli = invokeCli();
      expect(wrongHeadCli.exitCode, wrongHeadCli.stderr).toBe(0);
      expect(JSON.parse(wrongHeadCli.stdout)).toMatchObject({ candidateOnly: true, neverBlocks: true });
      assertUnverified(JSON.parse(wrongHeadCli.stdout).rows[0]);
      gitW('checkout', '--detach', prHeadSha);

      expect(invokeCli(null).exitCode).toBe(2);
      expect(invokeCli('f'.repeat(40)).exitCode).toBe(2);
      expect(reverify(targetIssue, { prHeadSha: 'invalid' }).rows[0])
        .toMatchObject({ status: 'unverified', reason: 'producer-unreachable' });
      expect(invokeCli('invalid').exitCode).toBe(2);
      renameSync(join(reviewRoot, '.git'), join(reviewRoot, '.git.saved'));
      try {
        assertUnverified(reverify(targetIssue).rows[0]);
        const unavailableHead = invokeCli();
        expect(unavailableHead.exitCode, unavailableHead.stderr).toBe(0);
        assertUnverified(JSON.parse(unavailableHead.stdout).rows[0]);
      } finally { renameSync(join(reviewRoot, '.git.saved'), join(reviewRoot, '.git')); }

      assertUnverified(reverify(targetIssue, { forceProducerUnreachable: true }).rows[0]);
      const unavailableSandbox = invokeCli(prHeadSha, captured.snapshotPath, ['--force-producer-unreachable']);
      expect(unavailableSandbox.exitCode, unavailableSandbox.stderr).toBe(0);
      assertUnverified(JSON.parse(unavailableSandbox.stdout).rows[0]);

      writeFileSync(join(reviewRoot, 'scripts', 'verify-boundary.mjs'), 'process.exit(77);\n');
      assertUnverified(reverify(targetIssue).rows[0]);
      const dirtyCli = invokeCli();
      expect(dirtyCli.exitCode, dirtyCli.stderr).toBe(0);
      assertUnverified(JSON.parse(dirtyCli.stdout).rows[0]);
      gitW('checkout', '--', 'scripts/verify-boundary.mjs');

      writeFileSync(join(reviewRoot, 'scripts', 'proof-input.mjs'), dependency + '\nthrow new Error("untrusted dependency executed");\n');
      assertBothUnverified();
      gitW('add', 'scripts/proof-input.mjs');
      gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'PR-modified producer dependency');
      assertBothUnverified();
      gitW('checkout', '--detach', prHeadSha);

      gitW('remote', 'set-url', 'origin', 'https://github.com/example/wrong-origin.git');
      assertUnverified(reverify(targetIssue).rows[0]);
      const wrongOriginCli = invokeCli();
      expect(wrongOriginCli.exitCode, wrongOriginCli.stderr).toBe(0);
      assertUnverified(JSON.parse(wrongOriginCli.stdout).rows[0]);
      gitW('remote', 'set-url', 'origin', 'https://github.com/' + repository + '.git');

      rmSync(join(targetRoot, 'scripts', 'verify-boundary.mjs'));
      assertUnverified(reverify(targetIssue).rows[0]);
      const noPrimaryCli = invokeCli();
      expect(noPrimaryCli.exitCode, noPrimaryCli.stderr).toBe(0);
      assertUnverified(JSON.parse(noPrimaryCli.stdout).rows[0]);
      writeFileSync(join(targetRoot, 'scripts', 'verify-boundary.mjs'), observedProducer);

      const outside = join(temp, 'outside-producer.mjs');
      writeFileSync(outside, observedProducer);
      rmSync(join(reviewRoot, 'scripts', 'verify-boundary.mjs'));
      symlinkSync(outside, join(reviewRoot, 'scripts', 'verify-boundary.mjs'));
      gitW('add', 'scripts/verify-boundary.mjs');
      gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'unsafe link');
      assertUnverified(reverify(targetIssue, { prHeadSha: headW() }).rows[0]);
      assertBothUnverified();
      gitW('checkout', '--detach', prHeadSha);

      writeFileSync(join(reviewRoot, 'scripts', 'w-only.mjs'), observedProducer);
      gitW('add', 'scripts/w-only.mjs');
      gitW('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'W-only script');
      putCard({ ...card, contractEvidenceProducer: {
        name: 'target-status', boundaryCommand: 'node scripts/w-only.mjs',
      } });
      assertUnverified(reverify(makeIssue('target-status', 'node scripts/w-only.mjs'),
        { prHeadSha: headW() }).rows[0]);
      assertBothUnverified(makeIssue('target-status', 'node scripts/w-only.mjs'));
      gitW('checkout', '--detach', prHeadSha);
      putCard(card);

      rmSync(join(reviewRoot, 'scripts', 'verify-boundary.mjs'));
      assertBothUnverified(); // P and pack must never replace missing W input.
      gitW('checkout', '--', 'scripts/verify-boundary.mjs');

      putCard({ ...card, contractEvidenceProducer: {
        name: 'target-status', boundaryCommand: 'node scripts/different.mjs',
      } });
      assertBothUnverified();
      putCard(card);
      assertBothUnverified(makeIssue('target-status', boundaryCommand + ' --unapproved'));

      putCard({ ...card, contractEvidenceProducer: undefined });
      expect(checkTierGateGuard(targetIssue, floorOptions).errors.join('\n')).toContain('not declared by the selected project card');
      expect(checkContractEvidence(targetIssue, floorOptions).errors.join('\n'))
        .toContain('not declared by the selected project card');
      expect(reverify(targetIssue).rows[0]).toMatchObject({ status: 'unverified', reason: 'unsupported-producer' });
      assertBothUnverified();
      putCard(card);
      gitW('checkout', '--detach', prHeadSha);

      const badBinding = targetIssue.replace('binding-id: target-status:', 'binding-id: other-producer:');
      expect(checkTierGateGuard(badBinding, floorOptions).errors.join('\n')).toContain('does not match binding-id');
      expect(checkContractEvidence(badBinding, floorOptions).errors.join('\n')).toContain('does not match binding-id producer');
      expect(reverify(badBinding).rows[0]).toMatchObject({ status: 'unverified', reason: 'unsupported-producer' });

      const wrongIndependent = makeIssue('target-status', 'node ' + producerDir + '/structured-value.mjs');
      expect(checkTierGateGuard(wrongIndependent, floorOptions).ok).toBe(false);
      expect(checkContractEvidence(wrongIndependent, floorOptions).errors.join('\n'))
        .toContain('target producer proof must use a safe executable proof-command');
      expect(reverify(wrongIndependent, { forceProducerUnreachable: true }).rows[0])
        .toMatchObject({ status: 'unverified', reason: 'non-genuine-proof' });

      const unsafe = makeIssue('target-status', boundaryCommand, 'sh -c unsafe');
      expect(checkTierGateGuard(unsafe, floorOptions).ok).toBe(false);
      expect(checkContractEvidence(unsafe, floorOptions).errors.join('\n'))
        .toContain('target producer proof must use a safe executable proof-command');
      expect(reverify(unsafe).rows[0]).toMatchObject({ status: 'unverified', reason: 'unsafe-or-undeclared-command' });

      const echoOnly = makeIssue('target-status', boundaryCommand, 'node ' + producerDir + '/echo-expected.mjs');
      expect(reverify(echoOnly, { forceProducerUnreachable: true }).rows[0])
        .toMatchObject({ status: 'unverified', reason: 'non-genuine-proof' });

      const packIssue = makeIssue('orchestrator-pack');
      expect(checkTierGateGuard(packIssue, floorOptions).ok).toBe(true);
      expect(checkContractEvidence(packIssue, floorOptions)).toMatchObject({ ok: true, errors: [], skipped: false });
      expect(checkTierGateGuard(valid, floorOptions).ok).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('accepts below-the-ladder work without tier review while retaining substantive floors', () => {
    const noTier = valid.replace(
      'tier: T2\nfailure-type: local-behavior\nsize: single-component-design-judgment',
      'skip-line: true',
    );
    const result = checkTierGateGuard(noTier);
    expect(result.ok).toBe(true);
    expect(parseComplexityTierFence(noTier)).toEqual({ kind: 'no-tier', skipLine: true });
    expect(formatTierGatePassMessage(result)).toContain('PASS (no-tier skip-line)');
    const missingWorkerSafety = checkTierGateGuard(noTier.replaceAll('vendor/**\n', ''));
    expect(missingWorkerSafety.ok).toBe(false);
    expect(missingWorkerSafety.errors.join('\n')).toContain('vendor/**');
  });

  it('fails closed on missing worker-safety and body floors', () => {
    const result = checkTierGateGuard(valid
      .replace('packages/core/**\n', '')
      .replace('## Verification\n- AC1: run.\n\n', ''));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('packages/core/**');
    expect(result.errors.join('\n')).toContain('missing ## Verification');
  });

  it('accepts T1 denylist filename suffixes without widening the allowed-roots ceiling', () => {
    const realistic = valid
      .replace('tier: T2', 'tier: T1')
      .replace('size: single-component-design-judgment', 'size: small-obvious-self-contained')
      .replace(
        'packages/core/**\nvendor/**\n',
        'packages/core/**\nvendor/**\n.env*\n.env.*\nsecrets/key*\n',
      );
    expect(checkTierGateGuard(realistic)).toMatchObject({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(realistic)).toEqual({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(valid.replace('allowed-roots\nscripts/**\n', 'allowed-roots\nsrc/**\n')))
      .toEqual({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(valid)).toEqual({ ok: true, errors: [] });
  });

  it('rejects malformed Issue policy entries with exact shared field/index errors', () => {
    const cases: Array<{ field: 'allowed_roots' | 'denylist'; pattern: string }> = [
      { field: 'allowed_roots', pattern: 'src/*.py' },
      { field: 'allowed_roots', pattern: 'scripts/*.ts' },
      { field: 'allowed_roots', pattern: 'plugins/**/tests/*.test.ts' },
      { field: 'allowed_roots', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: '**/credentials/**' },
      { field: 'denylist', pattern: '**/secrets/**' },
      { field: 'denylist', pattern: 'secrets/*.pem' },
      { field: 'denylist', pattern: 'scripts/*.ts' },
      { field: 'denylist', pattern: 'scripts/*' },
      { field: 'denylist', pattern: 'scripts/foo*bar' },
      { field: 'denylist', pattern: 'scripts/foo**' },
    ];
    for (const { field, pattern } of cases) {
      const index = field === 'denylist' ? 2 : 1;
      const canonical = canonicalizeEntry(pattern, field, index);
      expect(canonical.ok).toBe(false);
      if (canonical.ok) throw new Error('expected invalid canonicalization');
      const issue = field === 'denylist'
        ? valid.replace('packages/core/**\nvendor/**\n', 'packages/core/**\nvendor/**\n' + pattern + '\n')
        : valid.replace('allowed-roots\nscripts/**\n', 'allowed-roots\nscripts/**\n' + pattern + '\n');
      expect(checkWorkerSafetyFloor(issue).errors).toContain(canonical.error);
      expect(checkTierGateGuard(issue)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([canonical.error]),
      });
    }
  });

  it('validates every repeated scope fence using parser-aligned entry indices', () => {
    const mark = String.fromCharCode(96).repeat(3);
    for (const { fence, field, pattern, index } of [
      { fence: 'denylist', field: 'denylist', pattern: 'secrets/*.pem', index: 2 },
      { fence: 'denylist', field: 'denylist', pattern: '**/credentials/**', index: 2 },
      { fence: 'allowed-roots', field: 'allowed_roots', pattern: 'scripts/*.ts', index: 1 },
    ] as const) {
      const issue = valid + ['', mark + fence, '# ignored comment', '', pattern, mark, ''].join('\n');
      const canonical = canonicalizeEntry(pattern, field, index);
      expect(canonical.ok).toBe(false);
      if (canonical.ok) throw new Error('expected invalid canonicalization');
      expect(checkWorkerSafetyFloor(issue)).toMatchObject({
        ok: false, errors: expect.arrayContaining([canonical.error]),
      });
      expect(checkTierGateGuard(issue)).toMatchObject({
        ok: false, errors: expect.arrayContaining([canonical.error]),
      });
    }

    // The required denies may also be split across multiple valid fences.
    const splitDenylist = valid.replace(
      'packages/core/**\nvendor/**\n', 'packages/core/**\n',
    ) + ['', mark + 'denylist', '# ignored comment', 'vendor/**', mark, ''].join('\n');
    expect(checkWorkerSafetyFloor(splitDenylist)).toEqual({ ok: true, errors: [] });
  });

  it('uses the shared Issue occurrence parser without imposing guarded multiplicity on tier checks', () => {
    const mark = String.fromCharCode(96).repeat(3);
    const duplicated = valid + '\n' + [mark + 'denylist', 'secrets/**', mark, ''].join('\n');
    expect(checkWorkerSafetyFloor(duplicated)).toEqual({ ok: true, errors: [] });
    expect(checkTierGateGuard(duplicated)).toMatchObject({ ok: true });
    const missingMandatory = valid.replace('packages/core/**\nvendor/**\n', 'packages/core/**\n');
    expect(checkWorkerSafetyFloor(missingMandatory).errors).toContain(
      'worker-safety floor: denylist must include vendor/**',
    );
  });

  it('rejects an invalid tier without adding review topology', () => {
    const result = checkTierGateGuard(valid.replace('tier: T2', 'tier: T4'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('T1, T2, or T3');
  });
});
