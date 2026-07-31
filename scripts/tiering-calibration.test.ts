import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FROZEN_BASELINE_DIGEST,
  parseCalibrationRows,
  serializeCalibrationRows,
  validateCalibration,
} from './tiering-calibration.ts';
import { createHash } from 'node:crypto';

const committed = readFileSync('docs/tiering-calibration.md', 'utf8');

function mutateRow(text: string, issue: string, replacement: string): string {
  return text.replace(new RegExp(`^\\| ${issue} \\|.*$`, 'm'), replacement);
}

describe('Issue #1142 tiering calibration integrity', () => {
  it('accepts the exact committed 30-row baseline and frozen digest', () => {
    const rows = parseCalibrationRows(committed);
    expect(rows).toHaveLength(30);
    expect(validateCalibration(committed)).toEqual([]);
    expect(createHash('sha256').update(serializeCalibrationRows(rows), 'utf8').digest('hex')).toBe(FROZEN_BASELINE_DIGEST);
  });

  it('rejects a semantic field mutation, audited T2 relabel, removal, duplicate, and reorder', () => {
    expect(validateCalibration(mutateRow(committed, '1036', '| 1036 | T3 | T3 | T3 | T3 |')).join('\n')).toContain('digest mismatch');
    expect(validateCalibration(committed.replace('| 1089 | T3 | T2 | T2 | T2 |', '')).join('\n')).toContain('expected at least');
    expect(validateCalibration(committed.replace('| 1090 | T3 | T2 | T2 | T2 |', '| 1090 | T3 | T2 | T2 | T2 |\n| 1090 | T3 | T2 | T2 | T2 |')).join('\n')).toContain('duplicate Issue');
    const swapped = committed
      .replace('| 1030 | T3 | T2 | T2 | T2 |', '__A__')
      .replace('| 1031 | T3 | T3 | T3 | T3 |', '| 1030 | T3 | T2 | T2 | T2 |')
      .replace('__A__', '| 1031 | T3 | T3 | T3 | T3 |');
    expect(validateCalibration(swapped).join('\n')).toContain('digest mismatch');
  });

  it('rejects loss of either disputed verdict through the frozen digest', () => {
    const mutated = mutateRow(committed, '1039', '| 1039 | T3 | T2 | T2 | DISPUTED |');
    expect(validateCalibration(mutated).join('\n')).toContain('digest mismatch');
  });

  it('requires the base row sequence as an exact prefix and permits append-only growth', () => {
    const append = `${committed.trimEnd()}\n| 1200 | T2 | T2 | T2 | T2 |\n`;
    expect(validateCalibration(append, committed)).toEqual([]);
    const editedBase = mutateRow(append, '1030', '| 1030 | T3 | T3 | T3 | T3 |');
    expect(validateCalibration(editedBase, committed).join('\n')).toContain('exact prefix');
  });
});
