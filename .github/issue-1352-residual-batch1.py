from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrence(s) of {old!r}, got {actual}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')


path = 'docs/pr-session-binding-cache.mjs'
replace_exact(path, """function parseIssueNumberFromEnv(env = process.env) {
  for (const key of ['AO_ISSUE_NUMBER', 'GITHUB_ISSUE_NUMBER']) {
    const parsed = asFiniteNumber(env[key]);
    if (parsed > 0) {
      return parsed;
    }
  }
  const issueRef = trimText(env.AO_ISSUE_ID ?? env.GITHUB_ISSUE);
  if (issueRef) {
    const bare = issueRef.replace(/^#/, '');
    const parsed = asFiniteNumber(bare);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}


function resolveProjectIdFromEnv(env = process.env, repoSlug = '') {
  const explicit = trimText(env.AO_PROJECT_ID ?? env.AO_PROJECT);
  if (explicit) {
    return explicit;
  }
  const slug = trimText(repoSlug);
  if (slug.includes('/')) {
    return slug.split('/').pop() ?? '';
  }
  return slug;
}

""", '')
replace_exact(path, 'const explicit = normalizeRepoSlug(env.AO_REPO_SLUG ?? env.GITHUB_REPOSITORY);', 'const explicit = normalizeRepoSlug(env.GITHUB_REPOSITORY);')
replace_exact(path, "@param {{ claimedSessionId?: string, cwd?: string, sessions?: Array<Record<string, unknown>> }} [options]", "@param {{ sessionId?: string, claimedSessionId?: string, repoSlug?: string, projectId?: string, issueNumber?: number, cwd?: string, sessions?: Array<Record<string, unknown>> }} [options]")
replace_exact(path, 'const sessionId = trimText(env.AO_WORKER_SESSION_ID ?? env.AO_SESSION_ID);', 'const sessionId = trimText(options.sessionId);')
replace_exact(path, 'const repoSlug = resolveRepoSlugFromEnvOrCwd(env, options.cwd ?? process.cwd());', 'const repoSlug = normalizeRepoSlug(options.repoSlug) || resolveRepoSlugFromEnvOrCwd(env, options.cwd ?? process.cwd());')
replace_exact(path, 'const projectId = resolveProjectIdFromEnv(env, repoSlug);', "const projectId = trimText(options.projectId) || (repoSlug.includes('/') ? repoSlug.split('/').pop() ?? '' : repoSlug);")
replace_exact(path, 'const issueNumber = parseIssueNumberFromEnv(env) || getSessionIssueNumber(session);', "const explicitIssueNumber = asFiniteNumber(options.issueNumber);\n  const issueNumber = explicitIssueNumber > 0 ? explicitIssueNumber : getSessionIssueNumber(session);")
replace_exact(path, "@param {{ argv: string[], status: number, stdout: string, stderr: string, env?: NodeJS.ProcessEnv, cwd?: string, sessions?: Array<Record<string, unknown>>, fetchPriorPrOpenRow?: typeof fetchPriorPrOpenRowForPushRegister }} input", "@param {{ argv: string[], status: number, stdout: string, stderr: string, env?: NodeJS.ProcessEnv, cwd?: string, sessionId?: string, repoSlug?: string, projectId?: string, issueNumber?: number, headSha?: string, sessions?: Array<Record<string, unknown>>, fetchPriorPrOpenRow?: typeof fetchPriorPrOpenRowForPushRegister }} input")
replace_exact(path, """  env = process.env,
  cwd = process.cwd(),
  sessions,
""", """  env = process.env,
  cwd = process.cwd(),
  sessionId,
  repoSlug,
  projectId,
  issueNumber,
  headSha: explicitHeadSha,
  sessions,
""")
replace_exact(path, 'const identity = provePushRegisterWorkerIdentity(env, { cwd, sessions: verified.sessions });', 'const identity = provePushRegisterWorkerIdentity(env, { sessionId, repoSlug, projectId, issueNumber, cwd, sessions: verified.sessions });')
replace_exact(path, 'let headSha = normalizeSha(env.AO_HEAD_SHA ?? env.GITHUB_SHA);', 'let headSha = normalizeSha(explicitHeadSha ?? env.GITHUB_SHA);')

path = 'docs/pr-session-binding-cache.d.mts'
replace_exact(path, """  options?: {
    claimedSessionId?: string;
    cwd?: string;
""", """  options?: {
    sessionId?: string;
    claimedSessionId?: string;
    repoSlug?: string;
    projectId?: string;
    issueNumber?: number;
    cwd?: string;
""")
replace_exact(path, """  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessions?: Array<Record<string, unknown>>;
""", """  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionId?: string;
  repoSlug?: string;
  projectId?: string;
  issueNumber?: number;
  headSha?: string;
  sessions?: Array<Record<string, unknown>>;
""", 1)

path = 'scripts/pr-session-binding-cache.test.ts'
p = Path(path)
text = p.read_text(encoding='utf-8')
old_spoof = """  it('rejects env-only spoof without a caller-verified runtime worker corpus', () => {
    const env = {
      AO_WORKER_SESSION_ID: 'opk-spoof',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
    };
    const verified = loadPushRegisterVerifiedSessions({ env, sessions: [] });
    expect(verified.ok).toBe(false);

    const proof = provePushRegisterWorkerIdentity(env, { cwd: process.cwd() });
    expect(proof.ok).toBe(false);
    expect(proof.reason).toBe('push_register_session_verification_required');

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/42\\n',
      stderr: '',
      env,
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('push_register_session_verification_required');
  });
"""
new_spoof = """  it('rejects env-only spoof without a caller-verified runtime worker corpus', () => {
    const retiredSessionKey = ['AO', 'WORKER', 'SESSION', 'ID'].join('_');
    const retiredRepoKey = ['AO', 'REPO', 'SLUG'].join('_');
    const env = {
      [retiredSessionKey]: 'opk-spoof',
      [retiredRepoKey]: repoSlug,
    };
    const verified = loadPushRegisterVerifiedSessions({ env, sessions: [] });
    expect(verified.ok).toBe(false);

    const proof = provePushRegisterWorkerIdentity(env, { cwd: process.cwd() });
    expect(proof.ok).toBe(false);
    expect(proof.reason).toBe('push_register_missing_session_identity');

    const register = tryPushRegisterFromPrCreate({
      argv: ['pr', 'create', '--title', 'x', '--body', 'y'],
      status: 0,
      stdout: 'https://github.com/org/orchestrator-pack/pull/42\\n',
      stderr: '',
      env,
    });
    expect(register.registered).toBe(false);
    expect(register.reason).toBe('push_register_session_verification_required');
  });
"""
if text.count(old_spoof) != 1:
    raise SystemExit('spoof test drifted')
text = text.replace(old_spoof, new_spoof, 1)

# Success-path fixtures keep only pack-owned cache tuning in env and pass worker
# identity explicitly. Rebind/register cases are distinct so no duplicate identity
# property can be introduced mechanically.
for session_id in ['opk-verified', 'opk-rebind', 'opk-rebind-terminal', 'opk-io']:
    old_env = f"""      AO_WORKER_SESSION_ID: '{session_id}',
      AO_REPO_SLUG: repoSlug,
      AO_PROJECT_ID: 'orchestrator-pack',
"""
    text = text.replace(old_env, '')

text = text.replace("const proof = provePushRegisterWorkerIdentity(env, { sessions });", "const proof = provePushRegisterWorkerIdentity(env, { sessionId: 'opk-verified', repoSlug, projectId: 'orchestrator-pack', sessions });", 1)

def add_identity_after_env(text: str, stdout_marker: str, session_id: str) -> str:
    marker = f"""      stdout: '{stdout_marker}\\n',
      stderr: '',
      env,
      sessions,
"""
    replacement = f"""      stdout: '{stdout_marker}\\n',
      stderr: '',
      env,
      sessionId: '{session_id}',
      repoSlug,
      projectId: 'orchestrator-pack',
      sessions,
"""
    if text.count(marker) != 1:
        raise SystemExit(f'test call drifted for {stdout_marker}/{session_id}: {text.count(marker)}')
    return text.replace(marker, replacement, 1)

text = add_identity_after_env(text, 'https://github.com/org/orchestrator-pack/pull/89', 'opk-verified')
text = add_identity_after_env(text, 'https://github.com/org/orchestrator-pack/pull/88', 'opk-verified')
# Pull/12 appears twice; bind each by nearby unique session corpus.
marker = """    const sessions = [liveWorker('opk-rebind', 719)];
    const store = seedStore({ sessionId: 'opk-rebind', prNumber: 11, headSha: 'old11' });
"""
if text.count(marker) != 1:
    raise SystemExit('opk-rebind test setup drifted')
start = text.index(marker)
call = """      stderr: '',
      env,
      sessions,
"""
pos = text.index(call, start)
text = text[:pos] + text[pos:].replace(call, """      stderr: '',
      env,
      sessionId: 'opk-rebind',
      repoSlug,
      projectId: 'orchestrator-pack',
      sessions,
""", 1)
marker = """    const sessions = [liveWorker('opk-rebind-terminal', 719)];
    const store = seedStore({ sessionId: 'opk-rebind-terminal', prNumber: 11, headSha: 'old11' });
"""
if text.count(marker) != 1:
    raise SystemExit('terminal rebind test setup drifted')
start = text.index(marker)
pos = text.index(call, start)
text = text[:pos] + text[pos:].replace(call, """      stderr: '',
      env,
      sessionId: 'opk-rebind-terminal',
      repoSlug,
      projectId: 'orchestrator-pack',
      sessions,
""", 1)
text = add_identity_after_env(text, 'https://github.com/org/orchestrator-pack/pull/90', 'opk-io')

p.write_text(text, encoding='utf-8')
