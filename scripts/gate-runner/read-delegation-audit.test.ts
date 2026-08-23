// @vitest-ci-lane light

import { describe, expect, it } from 'vitest';

import {
  didAskTriggerFire,
  T1_VOLUME_FLOOR,
} from '../../docs/read-delegation-audit.mjs';

describe('read-delegation audit trigger', () => {
  it('uses one strict combined volume floor', () => {
    expect(T1_VOLUME_FLOOR).toBe(600);

    expect(didAskTriggerFire([{ kind: 'file', path: 'a.md', lines: 600 }]).fired).toBe(false);
    expect(didAskTriggerFire([{ kind: 'file', path: 'a.md', lines: 601 }]).fired).toBe(true);

    expect(didAskTriggerFire([{ kind: 'diff', lines: 600 }]).fired).toBe(false);
    expect(didAskTriggerFire([{ kind: 'diff', lines: 601 }]).fired).toBe(true);

    expect(
      didAskTriggerFire([
        { kind: 'file', path: 'a.md', lines: 400 },
        { kind: 'log', lines: 201 },
      ]).fired,
    ).toBe(true);
  });

  it('does not trigger from file count or a retired diff/log floor', () => {
    const threeFilesAtOldFloor: Parameters<typeof didAskTriggerFire>[0] = [
      { kind: 'file', path: 'a.md', lines: 200 },
      { kind: 'file', path: 'b.md', lines: 200 },
      { kind: 'file', path: 'c.md', lines: 200 },
    ];

    expect(didAskTriggerFire(threeFilesAtOldFloor)).toMatchObject({
      fired: false,
      t2: false,
      diffLog: false,
      fileCount: 3,
      delegableLines: 600,
    });
    expect(didAskTriggerFire([{ kind: 'diff', lines: 201 }]).fired).toBe(false);
  });
});
