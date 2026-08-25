import { describe, expect, it } from 'vitest';
import { buildSmokeAgentPrompt } from './worker-smoke-core-base.ts';

describe('buildSmokeAgentPrompt selected declaration artifact', () => {
  it('skips docs/declarations/<issue>.pr-scope.json from product path accounting', () => {
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 1260,
      issueBody: '```smoke-test-plan\nscenarios:\n  - action: scan paths | expected: only seven allowed paths\n```',
      prNumber: 1609,
      headSha: 'a'.repeat(40),
      plan: {
        requirement: 'required',
        scenarios: [{ action: 'scan paths', expected: 'only seven allowed paths' }],
      },
    });

    expect(prompt).toContain('docs/declarations/1260.pr-scope.json');
    expect(prompt).toMatch(/skipped from product changed-path accounting/u);
    expect(prompt).toMatch(/selectedArtifactPath/u);
    expect(prompt).toMatch(/Do not FAIL an exact-scope or allowed-path scenario solely because that file appears in git diff/u);
  });
});
