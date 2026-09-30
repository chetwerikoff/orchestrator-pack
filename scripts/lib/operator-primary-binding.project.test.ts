// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { projectCardPath } from './target-context.ts';
import { publishCurrentWorkerAssignment, resolveWorkerAssignmentStorePath } from './worker-assignment-store.ts';
import { parseOperatorPrimaryBindingArgs, runOperatorPrimaryBindingCommand } from '../operator-primary-binding.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Issue #2186 operator-primary retarget fence', () => {
  it('rejects CLI reads and locked mutations after changing the selected repository', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-2186-primary-'));
    roots.push(root);
    const env = { ...process.env, HOME: root, OPK_BASE_DIR: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), OPK_PROJECT_ID: 'alpha' };
    const primaryRoot = path.join(root, 'primary');
    mkdirSync(primaryRoot, { recursive: true });
    const git = (args: string[]) => {
      const result = runProcessSync({ command: 'git', args, cwd: primaryRoot, inheritParentEnv: true });
      if (!result.ok) throw new Error(result.stderr || result.error || 'git failed');
    };
    git(['init']);
    git(['remote', 'add', 'origin', 'https://github.com/owner/alpha.git']);
    const card = projectCardPath('alpha', env);
    mkdirSync(path.dirname(card), { recursive: true });
    const writeCard = (repository: string) => writeFileSync(card, JSON.stringify({
      projectId: 'alpha', repository, primaryRoot, defaultBranch: 'main',
      orcaWorkspacePattern: 'alpha', orchestratorTitlePattern: 'alpha',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/alpha' },
    }));
    writeCard('owner/alpha');
    const file = resolveWorkerAssignmentStorePath('alpha', env);
    const published = await publishCurrentWorkerAssignment({
      file, projectId: 'alpha', repository: 'owner/alpha',
      taskId: 'task-alpha', bindingKey: 'dispatch-alpha', issueNumber: 7,
      kind: 'local', provider: 'orca', role: 'worker',
    });
    if (!published.ok) throw new Error(published.reason);
    const bound = await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'bind', '--project', 'alpha', '--task-id', 'task-alpha', '--binding-key', 'dispatch-alpha',
      '--operator-attested',
    ]), env);
    expect(bound.ok).toBe(true);
    const shown = await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'show', '--project', 'alpha',
    ]), env);
    expect(shown).toMatchObject({ ok: true, status: 'binding_current' });
    const original = readFileSync(file, 'utf8');

    git(['remote', 'set-url', 'origin', 'https://github.com/owner/beta.git']);
    writeCard('owner/beta');
    const stale = await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'show', '--project', 'alpha',
    ]), env);
    expect(stale).toMatchObject({
      ok: false, reason: 'assignment_untrusted', cause: 'project_repository_mismatch',
    });
    const deniedRetire = await runOperatorPrimaryBindingCommand(parseOperatorPrimaryBindingArgs([
      'retire', '--project', 'alpha', '--operator-attested',
      '--expected-task-id', 'task-alpha', '--expected-binding-key', 'dispatch-alpha',
      '--expected-assignment-id', published.assignment.assignmentId,
      '--expected-assignment-generation', String(published.assignment.generation),
    ]), env);
    expect(deniedRetire).toMatchObject({
      ok: false, reason: 'assignment_store_untrusted', cause: 'project_repository_mismatch',
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
