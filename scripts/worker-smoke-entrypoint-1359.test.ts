// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Issue #2319 worker-smoke entrypoint', () => {
  it('is a thin launcher with no run-specific terminal/progress fallback', () => {
    const wrapper = readFileSync(new URL('./worker-smoke-run', import.meta.url), 'utf8');
    expect(wrapper).toContain('exec node --experimental-strip-types');
    expect(wrapper).toContain('scripts/worker-smoke-run.ts');
    expect(wrapper).not.toContain('canonicalProgress');
    expect(wrapper).not.toContain('WORKER_SMOKE_RUN_ARTIFACT_DIR');
    expect(wrapper).not.toContain("if [[ ${1:-} != 'run' ]]");
  });

  it('routes publish directly and has no nested-run or detached-owner entrypoint', () => {
    const source = readFileSync(new URL('./worker-smoke-run.ts', import.meta.url), 'utf8');
    expect(source).toContain("case 'publish': return runPublishSmoke(options);");
    expect(source).not.toContain("case 'run'");
    expect(source).not.toContain('startDetachedSmokeAttempt');
    expect(source).not.toContain('observeDetachedSmokeAttempt');
    expect(source).not.toContain('parseLatestSmokeReport');
    expect(source).not.toContain('--smoke-actor');
  });
});
