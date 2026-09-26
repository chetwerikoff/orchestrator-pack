import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export const SHARED_OPERATOR_RESOURCE_PERMIT = '<!-- smoke-plan-permit: shared-operator-resource -->' as const;
export const SMOKE_PLAN_PRECONDITION_CAUSE = 'scenario_precondition_unavailable' as const;

export type SmokePlanPreflightReason =
  | 'absolute_worktree_path_outside_artifact_dir'
  | 'shared_operator_cdp_requires_permit'
  | 'shared_operator_local_config_requires_permit'
  | 'source_revision_mismatch';

export interface SmokePlanPreflightScenario {
  readonly action: string;
  readonly expected: string;
}

export interface SmokePlanPreflightViolation {
  readonly reason: SmokePlanPreflightReason;
  readonly scenarioOrdinal: number;
  readonly action: string;
  readonly expected: string;
  readonly observed: string;
}

export type SmokePlanPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly causeFamily: typeof SMOKE_PLAN_PRECONDITION_CAUSE;
      readonly violation: SmokePlanPreflightViolation;
    };

const OPERATOR_CDP_RE = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):9222\b/iu;
const OPERATOR_LOCAL_CONFIG_RE = /(?:^|[\\/])\.claude[\\/]skills[\\/]discuss-with-gpt[\\/]local\.config\.json\b/iu;
const HARDCODED_SOURCE_REVISION_RE =
  /(?:--source-revision(?:\s+|=)|\bSOURCE_REVISION\s*=\s*|\bsource-revision\s*:\s*)["'`]?((?:r)\d+)\b/giu;

interface AbsolutePathReference {
  readonly value: string;
  readonly index: number;
}

function smokePlanFence(issueBody: string): string {
  const match = /^[ \t]*```smoke-test-plan[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/imu.exec(issueBody);
  return match?.[1] ?? '';
}

function liveSourceRevision(issueBody: string): string | undefined {
  const revisions: string[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (const line of issueBody.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (fence) {
      const close = new RegExp(`^${fence.character}{${fence.length},}\\s*$`, 'u');
      if (close.test(trimmed)) fence = undefined;
      continue;
    }
    const opener = /^(`{3,}|~{3,})/u.exec(trimmed)?.[1];
    if (opener) {
      fence = { character: opener[0] as '`' | '~', length: opener.length };
      continue;
    }
    const marker = /^<!--\s*source-revision:\s*(r\d+)\s*-->\s*$/iu.exec(line.trim());
    if (marker?.[1]) revisions.push(marker[1].toLowerCase());
  }
  const unique = [...new Set(revisions)];
  return unique.length === 1 ? unique[0] : undefined;
}

function cleanPathCandidate(value: string): string {
  return value.replace(/[\],.;:}]+$/u, '');
}

function absolutePathReferences(text: string): AbsolutePathReference[] {
  const references: AbsolutePathReference[] = [];
  const posix = /(?:^|[\s"'`=(])((?:\/(?!\/)[^\/\s"'`|<>]+)+)/gu;
  for (const match of text.matchAll(posix)) {
    const value = cleanPathCandidate(match[1] ?? '');
    if (!value || !isAbsolute(value)) continue;
    const prefixLength = (match[0]?.length ?? 0) - (match[1]?.length ?? 0);
    references.push({ value, index: (match.index ?? 0) + prefixLength });
  }
  const windows = /(?:^|[\s"'`=(])([A-Za-z]:[\\/][^\s"'`|<>]+)/gu;
  for (const match of text.matchAll(windows)) {
    const value = cleanPathCandidate(match[1] ?? '');
    if (!value || !win32.isAbsolute(value)) continue;
    const prefixLength = (match[0]?.length ?? 0) - (match[1]?.length ?? 0);
    references.push({ value, index: (match.index ?? 0) + prefixLength });
  }
  return references;
}

function pathWithinArtifactDir(candidate: string, artifactDir: string): boolean {
  if (win32.isAbsolute(candidate)) {
    if (!win32.isAbsolute(artifactDir)) return false;
    const rel = win32.relative(win32.resolve(artifactDir), win32.resolve(candidate));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${win32.sep}`) && !win32.isAbsolute(rel));
  }
  const rel = relative(resolve(artifactDir), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function looksLikeWorktreeReference(text: string, reference: AbsolutePathReference): boolean {
  const normalized = reference.value.replaceAll('\\', '/');
  if (/(?:^|\/)(?:worktrees?|workspaces)(?:\/|$)/iu.test(normalized)) return true;
  const prefix = text.slice(Math.max(0, reference.index - 120), reference.index);
  return /(?:\bgit\s+worktree\s+add\b[^\n|]{0,100}|\b(?:fixture\s+)?worktree(?:\s+(?:path|at|from|under|in))?\s+)[`"'(]*$/iu.test(prefix);
}

function violation(
  reason: SmokePlanPreflightReason,
  scenario: SmokePlanPreflightScenario,
  scenarioOrdinal: number,
  observed: string,
): SmokePlanPreflightResult {
  return {
    ok: false,
    causeFamily: SMOKE_PLAN_PRECONDITION_CAUSE,
    violation: {
      reason,
      scenarioOrdinal,
      action: scenario.action,
      expected: scenario.expected,
      observed,
    },
  };
}

export function evaluateSmokePlanPreflight(input: {
  readonly issueBody: string;
  readonly scenarios: readonly SmokePlanPreflightScenario[];
  readonly artifactDir: string;
}): SmokePlanPreflightResult {
  const permitSharedOperatorResource = smokePlanFence(input.issueBody).includes(SHARED_OPERATOR_RESOURCE_PERMIT);
  const liveRevision = liveSourceRevision(input.issueBody);

  for (const [index, scenario] of input.scenarios.entries()) {
    const scenarioOrdinal = index + 1;
    const text = `${scenario.action}\n${scenario.expected}`;

    for (const reference of absolutePathReferences(text)) {
      if (looksLikeWorktreeReference(text, reference) && !pathWithinArtifactDir(reference.value, input.artifactDir)) {
        return violation(
          'absolute_worktree_path_outside_artifact_dir',
          scenario,
          scenarioOrdinal,
          `smoke-plan absolute worktree path is outside run artifactDir: ${reference.value}`,
        );
      }
    }

    if (!permitSharedOperatorResource && OPERATOR_CDP_RE.test(text)) {
      return violation(
        'shared_operator_cdp_requires_permit',
        scenario,
        scenarioOrdinal,
        `smoke-plan names the shared operator CDP endpoint without ${SHARED_OPERATOR_RESOURCE_PERMIT}`,
      );
    }

    if (!permitSharedOperatorResource && OPERATOR_LOCAL_CONFIG_RE.test(text)) {
      return violation(
        'shared_operator_local_config_requires_permit',
        scenario,
        scenarioOrdinal,
        `smoke-plan names the operator local config without ${SHARED_OPERATOR_RESOURCE_PERMIT}`,
      );
    }

    const hardcodedRevisions = [...text.matchAll(HARDCODED_SOURCE_REVISION_RE)]
      .map((match) => match[1]?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    const mismatch = hardcodedRevisions.find((revision) => revision !== liveRevision);
    if (mismatch) {
      return violation(
        'source_revision_mismatch',
        scenario,
        scenarioOrdinal,
        `smoke-plan hardcodes source-revision ${mismatch}; live Issue marker is ${liveRevision ?? 'unavailable'}`,
      );
    }
  }

  return { ok: true };
}
