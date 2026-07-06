import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRAFT_AUTHOR_DENY_REASON =
  'Task draft authoring is delegated to an isolated Cursor draft-author session from the architect brief (Issue #579). Set AO_DRAFT_AUTHOR_FALLBACK_REASON to record a legitimate architect-as-author override per #579.';

const DIRECT_EDIT_DENY_REASON =
  'Architect direct edits to tracked implementation surfaces are blocked. Spawn an AO worker (`ao spawn`) instead, or set AO_DIRECT_EDIT_REASON to record an authorized override (see direct-fix-checklist skill).';

/**
 * @typedef {'allow' | 'deny'} GuardDecision
 */

/**
 * @typedef {object} GuardResult
 * @property {GuardDecision} decision
 * @property {string} [reason]
 * @property {'fail-open' | 'unchanged-allowlist' | 'review-subtree' | 'draft-override' | 'direct-edit-override' | 'gated-draft' | 'direct-edit-deny'} [rule]
 */

/**
 * @param {string | undefined} filePath
 * @param {string} projectDir
 * @returns {string | null}
 */
export function resolveProjectRelativePath(filePath, projectDir) {
  if (filePath === undefined || filePath === null || String(filePath).trim() === '') {
    return null;
  }

  const resolved = path.resolve(projectDir, String(filePath));
  const relative = path.relative(path.resolve(projectDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return relative.split(path.sep).join('/');
}

/**
 * @param {string} relativePosix
 */
export function isUnchangedAllowlisted(relativePosix) {
  if (
    relativePosix === 'CLAUDE.md' ||
    relativePosix === 'docs/architecture.md' ||
    relativePosix === 'docs/issue_queue_index.md' ||
    relativePosix === 'agent-orchestrator.yaml'
  ) {
    return true;
  }

  return (
    relativePosix === '.claude' ||
    relativePosix.startsWith('.claude/') ||
    relativePosix === '.ao' ||
    relativePosix.startsWith('.ao/')
  );
}

/**
 * @param {string} relativePosix
 */
export function isReviewSubtree(relativePosix) {
  return (
    relativePosix === 'docs/issues_drafts/.review' ||
    relativePosix.startsWith('docs/issues_drafts/.review/')
  );
}

/**
 * @param {string} relativePosix
 */
export function isGatedDraftFile(relativePosix) {
  return /^docs\/issues_drafts\/[^/]+\.md$/.test(relativePosix);
}

/**
 * @param {Record<string, string | undefined>} env
 */
function trimmedEnv(env, key) {
  return String(env[key] ?? '').trim();
}

/**
 * @param {object} input
 * @param {string | undefined} input.filePath
 * @param {string} [input.projectDir]
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {GuardResult}
 */
export function evaluateDirectEditGuard(input) {
  const projectDir = input.projectDir ?? process.cwd();
  const env = input.env ?? process.env;
  const relative = resolveProjectRelativePath(input.filePath, projectDir);

  if (relative === null) {
    return { decision: 'allow', rule: 'fail-open' };
  }

  if (isUnchangedAllowlisted(relative)) {
    return { decision: 'allow', rule: 'unchanged-allowlist' };
  }

  if (isReviewSubtree(relative)) {
    return { decision: 'allow', rule: 'review-subtree' };
  }

  if (isGatedDraftFile(relative)) {
    if (trimmedEnv(env, 'AO_DRAFT_AUTHOR_FALLBACK_REASON')) {
      return { decision: 'allow', rule: 'draft-override' };
    }
    return {
      decision: 'deny',
      reason: DRAFT_AUTHOR_DENY_REASON,
      rule: 'gated-draft',
    };
  }

  if (trimmedEnv(env, 'AO_DIRECT_EDIT_REASON')) {
    return { decision: 'allow', rule: 'direct-edit-override' };
  }

  return {
    decision: 'deny',
    reason: DIRECT_EDIT_DENY_REASON,
    rule: 'direct-edit-deny',
  };
}

/**
 * @param {string} stdin
 * @param {object} [options]
 * @param {string} [options.projectDir]
 * @param {Record<string, string | undefined>} [options.env]
 */
export function runHookFromStdin(stdin, options = {}) {
  const projectDir = options.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const env = options.env ?? process.env;

  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { exitCode: 0, stdout: '', decision: 'allow', rule: 'fail-open' };
  }

  const filePath = payload?.tool_input?.file_path;
  if (filePath === undefined || filePath === null || String(filePath).trim() === '') {
    return { exitCode: 0, stdout: '', decision: 'allow', rule: 'fail-open' };
  }

  const result = evaluateDirectEditGuard({ filePath, projectDir, env });
  if (result.decision === 'deny') {
    return {
      exitCode: 0,
      stdout: formatDenyOutput(result.reason ?? DIRECT_EDIT_DENY_REASON),
      decision: 'deny',
      rule: result.rule,
      reason: result.reason,
    };
  }

  return {
    exitCode: 0,
    stdout: '',
    decision: 'allow',
    rule: result.rule,
  };
}

/**
 * @param {string} reason
 */
export function formatDenyOutput(reason) {
  return `${JSON.stringify(
    {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    },
    null,
    0,
  )}\n`;
}

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('guard-direct-edit.mjs'));
}

export async function runCli() {
  const stdin = readFileSync(0, 'utf8');
  const result = runHookFromStdin(stdin);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  return result.exitCode;
}

if (isCliMain()) {
  runCli()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));
}
