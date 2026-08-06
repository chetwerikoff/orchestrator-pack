import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { writePowerShellTestBaseline } from './toolchain/check-pwsh-test-growth.ts';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function replaceOnce(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one replacement anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}

describe('Issue 1343 payload bootstrap', () => {
  it('emits the reviewed direct-file payload', () => {
    const inventoryPath = 'scripts/lib/gh-inventory-match.mjs';
    let inventory = read(inventoryPath);
    inventory = replaceOnce(
      inventory,
      "/** @typedef {'pr-list-open' | 'pr-list-head' | 'pr-list-merged-closes' | 'pr-view' | 'pr-checks' | 'pr-diff-name-only' | 'issue-view-body' | 'issue-view-json' | 'repo-view-name-with-owner' | 'runtime-history-main-required-status-checks' | 'runtime-history-actions-run' | 'runtime-history-status-history'} InventoryRouteId */",
      "/** @typedef {'pr-list-open' | 'pr-list-head' | 'pr-list-merged-closes' | 'pr-view' | 'pr-checks' | 'pr-diff-name-only' | 'issue-view-body' | 'issue-view-json' | 'repo-view-name-with-owner' | 'authenticated-user' | 'issue-comments-paginated' | 'runtime-history-main-required-status-checks' | 'runtime-history-actions-run' | 'runtime-history-status-history'} InventoryRouteId */",
      'inventory typedef',
    );
    const inventoryAnchor = `export function hasOnlyAllowedFlags(parsed, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(parsed.flags).every((key) => allowedSet.has(key));
}
`;
    const inventoryAddition = `${inventoryAnchor}
function matchWorkerSmokeApiRoute(parsed) {
  const endpoint = parsed.subcommand[1] ?? '';
  if (
    !endpoint
    || parsed.positionals.length > 0
    || parsed.jq
    || parsed.jsonFields
    || parsed.repo
    || parsed.hostname
  ) {
    return null;
  }

  if (endpoint === 'user' && hasOnlyAllowedFlags(parsed, [])) {
    return { id: 'authenticated-user' };
  }

  const comments = endpoint.match(/^repos\\/([^/]+\\/[^/]+)\\/issues\\/(\\d+)\\/comments$/i);
  if (!comments || !hasOnlyAllowedFlags(parsed, ['--paginate', '--slurp'])) {
    return null;
  }
  if (parsed.flags['--paginate'] !== true || parsed.flags['--slurp'] !== true) {
    return null;
  }
  const prNumber = Number(comments[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return null;
  }
  return {
    id: 'issue-comments-paginated',
    repoSlug: comments[1],
    prNumber,
  };
}
`;
    inventory = replaceOnce(inventory, inventoryAnchor, inventoryAddition, 'inventory worker-smoke routes');
    inventory = replaceOnce(
      inventory,
      "  if (root === 'api') {\n    return matchRuntimeHistoryApiRoute(parsed);\n  }",
      "  if (root === 'api') {\n    return matchWorkerSmokeApiRoute(parsed) ?? matchRuntimeHistoryApiRoute(parsed);\n  }",
      'inventory api dispatch',
    );
    write(inventoryPath, inventory);

    const restPath = 'scripts/lib/gh-rest-routes.mjs';
    let rest = read(restPath);
    const restAnchor = `function assertRuntimeHistoryRepo(route, repo) {`;
    const restAddition = `export function routeAuthenticatedUser(realGh, cwd) {
  return ghApiJson(realGh, 'user', { cwd });
}

export function routeIssueCommentsPaginated(realGh, repo, prNumber, cwd) {
  const pages = [];
  const seenIds = new Set();
  const perPage = 100;
  let page = 1;
  while (true) {
    if (page > 100) {
      throw new Error(\`${'${REST_ERROR_MARKER}'}: issue-comment pagination completeness unprovable\`);
    }
    const batch = ghApiJson(
      realGh,
      \`repos/${'${repo.slug}'}/issues/${'${prNumber}'}/comments?per_page=${'${perPage}'}&page=${'${page}'}\`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(batch)) {
      throw new Error(\`${'${REST_ERROR_MARKER}'}: issue-comment page is not an array\`);
    }
    for (const comment of batch) {
      const id = Number(comment?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) {
        throw new Error(\`${'${REST_ERROR_MARKER}'}: issue-comment identity is malformed or duplicated\`);
      }
      seenIds.add(id);
    }
    pages.push(batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return pages;
}

${restAnchor}`;
    rest = replaceOnce(rest, restAnchor, restAddition, 'rest worker-smoke routes');
    const switchAnchor = `      case 'runtime-history-main-required-status-checks':`;
    const switchAddition = `      case 'authenticated-user':
        return routeAuthenticatedUser(realGh, cwd);
      case 'issue-comments-paginated':
        if (String(route.repoSlug ?? '').toLowerCase() !== repo.slug.toLowerCase()) {
          throw new Error(\`${'${REST_ERROR_MARKER}'}: issue-comment route repository mismatch\`);
        }
        return routeIssueCommentsPaginated(
          realGh,
          repo,
          route.prNumber,
          cwd,
        );
${switchAnchor}`;
    rest = replaceOnce(rest, switchAnchor, switchAddition, 'rest route dispatch');
    write(restPath, rest);

    const wrapperTestPath = 'scripts/gh-wrapper.test.ts';
    let wrapperTest = read(wrapperTestPath);
    const wrapperAnchor = `  it('routes pr diff name-only', () => {`;
    const wrapperAddition = `  it('routes the authenticated publication principal read', () => {
    const { route } = classifyArgv(['api', 'user']);
    expect(route?.id).toBe('authenticated-user');
  });

  it('routes the complete worker-smoke issue-comment census', () => {
    const { route } = classifyArgv([
      'api',
      'repos/chetwerikoff/orchestrator-pack/issues/1360/comments',
      '--paginate',
      '--slurp',
    ]);
    expect(route).toEqual({
      id: 'issue-comments-paginated',
      repoSlug: 'chetwerikoff/orchestrator-pack',
      prNumber: 1360,
    });
  });

  it('does not inventory an incomplete worker-smoke comment read', () => {
    const { route } = classifyArgv([
      'api', 'repos/chetwerikoff/orchestrator-pack/issues/1360/comments', '--paginate',
    ]);
    expect(route).toBeNull();
  });

${wrapperAnchor}`;
    wrapperTest = replaceOnce(wrapperTest, wrapperAnchor, wrapperAddition, 'wrapper inventory tests');
    write(wrapperTestPath, wrapperTest);

    const corePath = 'scripts/lib/worker-smoke-core.ts';
    const core = replaceOnce(
      read(corePath),
      'if (!input.ownedTerminalClosed && !coverage.latestClearingPass) {',
      'if (!input.ownedTerminalClosed) {',
      'strict terminal cleanup',
    );
    write(corePath, core);

    const runPath = 'scripts/worker-smoke-run.ts';
    let run = read(runPath);
    const oldFinal = `    if (decision.allowed) {
      const finalComments = dependencies.fetchComments(
        options.prNumber,
        target.repositorySlug,
        options.repoRoot,
      );
      if (!finalSmokeCommentSnapshotMatches(comments, finalComments)) {
        decision = {
          allowed: false,
          reason: 'comment_snapshot_changed_before_allow',
          smokeRequired: true,
          diagnostics: decision.diagnostics,
        };
      } else {
        const finalHeadSha = dependencies.fetchHead(
          options.prNumber,
          target.repositorySlug,
          options.repoRoot,
        );
        if (finalHeadSha !== target.headSha) {
          decision = {
            allowed: false,
            reason: 'live_pr_head_changed_during_evaluation',
            smokeRequired: true,
            diagnostics: decision.diagnostics,
          };
        }
      }
    }
`;
    const newFinal = `    if (decision.allowed) {
      const finalHeadSha = dependencies.fetchHead(
        options.prNumber,
        target.repositorySlug,
        options.repoRoot,
      );
      if (finalHeadSha !== target.headSha) {
        decision = {
          allowed: false,
          reason: 'live_pr_head_changed_during_evaluation',
          smokeRequired: true,
          diagnostics: decision.diagnostics,
        };
      } else {
        const finalComments = dependencies.fetchComments(
          options.prNumber,
          target.repositorySlug,
          options.repoRoot,
        );
        if (!finalSmokeCommentSnapshotMatches(comments, finalComments)) {
          decision = {
            allowed: false,
            reason: 'comment_snapshot_changed_before_allow',
            smokeRequired: true,
            diagnostics: decision.diagnostics,
          };
        }
      }
    }
`;
    run = replaceOnce(run, oldFinal, newFinal, 'final authority ordering');
    write(runPath, run);

    const workerTestPath = 'scripts/worker-smoke.test.ts';
    let workerTest = read(workerTestPath);
    workerTest = replaceOnce(
      workerTest,
      "import { spawnSync } from 'node:child_process';\n",
      "import { runProcessSync } from './kernel/subprocess.ts';\n",
      'subprocess import',
    );
    const helperAnchor = "const REPOSITORY = 'chetwerikoff/orchestrator-pack';\n";
    const helper = `${helperAnchor}
function runChild(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const result = runProcessSync({
    command,
    args,
    env: options.env,
    inheritParentEnv: options.env === undefined,
  });
  return {
    status: result.exitCode ?? (result.ok ? 0 : 1),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
`;
    workerTest = replaceOnce(workerTest, helperAnchor, helper, 'subprocess helper');
    workerTest = workerTest.replaceAll('spawnSync(', 'runChild(');
    write(workerTestPath, workerTest);

    writePowerShellTestBaseline(process.cwd());

    const paths = [
      inventoryPath,
      restPath,
      wrapperTestPath,
      corePath,
      runPath,
      workerTestPath,
      'scripts/toolchain/powershell-child-tests.json',
    ];
    const payload = Object.fromEntries(paths.map((path) => [path, read(path)]));
    const encoded = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
    console.log(`ISSUE1343_PAYLOAD_BEGIN${encoded}ISSUE1343_PAYLOAD_END`);
  });
});
