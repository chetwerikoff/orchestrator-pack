import { describe, expect, it } from 'vitest';
import { resolveExecutorProfile } from './pr2-foundation/supervised-task-launch-assistant.ts';
import { resolveSmokeExecutorProfile } from './worker-smoke-run.ts';
import { overlayExecutorProfileEnv, readExecutorProfileStore } from './executor-profile-store.ts';

describe('machine-local executor profile store', () => {
  it('overlays fenced values once, with store values winning in task and smoke resolution', () => {
    let reads = 0;
    const env = {
      PATH: '/operator/bin',
      PACK_EXECUTOR_T2_AGENT: 'cursor-agent',
      PACK_EXECUTOR_T2_MODEL: 'live-task-model',
      PACK_EXECUTOR_T2_EFFORT: 'live-task-effort',
      PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'cursor',
      PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'live-smoke-model',
      PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'live-smoke-effort',
    };
    const effectiveEnv = overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => {
        reads += 1;
        return [
          '# operator-owned profiles',
          'PACK_EXECUTOR_T2_AGENT="cursor-agent"',
          'PACK_EXECUTOR_T2_MODEL=store-task-model',
          'PACK_EXECUTOR_T2_EFFORT=store-task-effort',
          'PACK_EXECUTOR_SMOKE_ROUTINE_AGENT=cursor',
          'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL=store-smoke-model',
          'PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT=store-smoke-effort',
        ].join('\n');
      },
    });

    expect(reads).toBe(1);
    expect(effectiveEnv.PATH).toBe('/operator/bin');
    expect(resolveExecutorProfile('t2', effectiveEnv, 'exact_terminal_worktree')).toMatchObject({
      status: 'ok',
      value: { launchCommand: "cursor-agent --model 'store-task-model-store-task-effort'" },
    });
    expect(resolveSmokeExecutorProfile('routine', effectiveEnv)).toMatchObject({
      command: "agent --model 'store-smoke-model-store-smoke-effort'",
    });
  });

  it('rejects a foreign key before applying any store values and never changes PATH', () => {
    const env = {
      PATH: '/operator/bin',
      PACK_EXECUTOR_T2_MODEL: 'live-model',
    };
    expect(() => overlayExecutorProfileEnv(env, {
      storePath: '/operator/executor-profiles.env',
      readFile: () => 'PACK_EXECUTOR_T2_MODEL=store-model\nPATH=/unsafe/bin\n',
    })).toThrow('executor_profile_store_malformed:line=2:key=PATH');
    expect(env).toEqual({
      PATH: '/operator/bin',
      PACK_EXECUTOR_T2_MODEL: 'live-model',
    });
  });

  it('treats a missing store as no overlay', () => {
    const env = { PATH: '/operator/bin' };
    expect(readExecutorProfileStore({
      storePath: '/operator/missing/executor-profiles.env',
      readFile: () => {
        const error = new Error('missing') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      },
    })).toEqual({});
    expect(overlayExecutorProfileEnv(env, {
      storePath: '/operator/missing/executor-profiles.env',
      readFile: () => {
        const error = new Error('missing') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      },
    })).toBe(env);
  });
});
