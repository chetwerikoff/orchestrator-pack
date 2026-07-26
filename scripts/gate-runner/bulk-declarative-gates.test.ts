import { describe, expect, it } from 'vitest';
import { captureSourceSnapshot, memorySnapshot } from './source-snapshot.ts';
import {
  bulkDeclarativeGateRegistrations,
  VERIFY_REQUIRED_FILES,
} from './bulk-declarative-gates.ts';

describe('Wave 3.b declarative gate ports', () => {
  it('passes the live/no-override required-file inventory', () => {
    const snapshot = captureSourceSnapshot(process.cwd());
    const result = bulkDeclarativeGateRegistrations[0]!.evaluate({ repoRoot: process.cwd(), snapshot });
    expect(result.status, result.details?.join('\n')).toBe('PASS');
    expect(result.legacyStdout).toBe('[PASS] verify required-file inventory\n');
  });

  it('has positive and negative file-presence fixtures', () => {
    const files = Object.fromEntries(VERIFY_REQUIRED_FILES.map((path) => [path, 'present']));
    const registration = bulkDeclarativeGateRegistrations[0]!;
    expect(registration.evaluate({ repoRoot: '/fixture', snapshot: memorySnapshot(files) }).status).toBe('PASS');
    const missingReadme = { ...files };
    delete missingReadme['README.md'];
    const failed = registration.evaluate({ repoRoot: '/fixture', snapshot: memorySnapshot(missingReadme) });
    expect(failed.status).toBe('FAIL');
    expect(failed.details?.join('\n')).toContain('README.md');
  });
});
