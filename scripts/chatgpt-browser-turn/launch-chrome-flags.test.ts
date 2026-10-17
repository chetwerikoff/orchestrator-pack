// @vitest-ci-lane light
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../../.claude/skills/discuss-with-gpt/launch-chrome.sh', import.meta.url), 'utf8');
const FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
] as const;

describe('Issue #2625 automation Chrome launch flags', () => {
  it('passes each background-throttling flag exactly once to WSL Start-Process', () => {
    const wsl = SOURCE.match(/Start-Process -FilePath '\$CHROME_WIN'[^\n]+/u)?.[0];
    expect(wsl).toBeDefined();
    expect(wsl).toContain("'--remote-debugging-port=9222'");
    expect(wsl).toContain("'--remote-allow-origins=*'");
    expect(wsl).toContain("'--user-data-dir=$PROFILE'");
    expect(wsl).toContain("'$URL'");
    for (const flag of FLAGS) {
      expect(wsl!.split("'" + flag + "'").length - 1).toBe(1);
    }
  });

  it('passes each flag exactly once to native Chrome and keeps profile, URL and CDP port', () => {
    const native = SOURCE.match(/"\$CHROME" --remote-debugging-port=9222[\s\S]*?--user-data-dir="\$PROFILE" "\$URL"/u)?.[0];
    expect(native).toBeDefined();
    expect(native).toContain('--remote-allow-origins=*');
    for (const flag of FLAGS) {
      expect(native!.split(flag).length - 1).toBe(1);
    }
  });

  it('returns on an already-running verified Chrome before spawning either process', () => {
    const reuse = SOURCE.indexOf('automation Chrome already up');
    const wsl = SOURCE.indexOf('Start-Process -FilePath');
    const native = SOURCE.indexOf('"$CHROME" --remote-debugging-port=9222');
    expect(reuse).toBeGreaterThan(0);
    expect(wsl).toBeGreaterThan(reuse);
    expect(native).toBeGreaterThan(reuse);
    expect(SOURCE).toContain('verify-cdp-owner.mjs" verify');
  });
});
