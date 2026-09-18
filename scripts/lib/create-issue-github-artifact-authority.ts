import type { GhTransport } from './create-issue-stage-record-types.ts';

export interface PrincipalOwnedIssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string | null;
  htmlUrl: string;
}

export type PrincipalArtifactSelection =
  | { ok: true; principalLogin: string; comment: PrincipalOwnedIssueComment }
  | { ok: false; principalLogin: string; cause: 'zero_principal_owned_match' | 'duplicate_principal_owned_match' | 'wrong_publisher'; detail: string };

export function sameGithubPrincipal(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    || left.toLowerCase() === right.toLowerCase();
}

export function resolveAuthenticatedGithubPrincipal(transport: GhTransport): string {
  const response = transport.runGh(['gh', 'api', 'user', '--jq', '.login']);
  if (response.exitCode !== 0) {
    throw new Error('authenticated GitHub principal GET /user failed');
  }
  const login = response.stdout.trim();
  if (!login || /\r|\n/.test(login)) {
    throw new Error('authenticated GitHub principal GET /user returned an invalid login');
  }
  return login;
}

/**
 * Candidate ownership is applied before uniqueness. `isCanonical` must include
 * the exact Issue/revision/invocation grammar owned by the caller.
 */
export function selectPrincipalOwnedCanonicalArtifact(
  comments: readonly PrincipalOwnedIssueComment[],
  principalLogin: string,
  isCanonical: (comment: PrincipalOwnedIssueComment) => boolean,
): PrincipalArtifactSelection {
  const principalComments = comments.filter((comment) => (
    typeof comment.userLogin === 'string'
    && sameGithubPrincipal(comment.userLogin, principalLogin)
  ));
  const matches = principalComments.filter(isCanonical);
  if (matches.length === 1) {
    return { ok: true, principalLogin, comment: matches[0]! };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      principalLogin,
      cause: 'duplicate_principal_owned_match',
      detail: `authenticated principal ${principalLogin} published ${matches.length} canonical reviewer artifacts: ${matches.map((comment) => comment.id).join(',')}`,
    };
  }
  const foreignMatches = comments.filter((comment) => (
    typeof comment.userLogin === 'string'
    && !sameGithubPrincipal(comment.userLogin, principalLogin)
    && isCanonical(comment)
  ));
  if (foreignMatches.length > 0) {
    return {
      ok: false,
      principalLogin,
      cause: 'wrong_publisher',
      detail: `canonical reviewer artifact exists only under a different publisher: ${foreignMatches.map((comment) => `${comment.id}:${comment.userLogin}`).join(',')}`,
    };
  }
  return {
    ok: false,
    principalLogin,
    cause: 'zero_principal_owned_match',
    detail: `authenticated principal ${principalLogin} has no canonical reviewer artifact for the admitted invocation`,
  };
}
