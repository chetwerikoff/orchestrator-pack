import { createHash } from 'node:crypto';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import type { StructuredFinding } from './types.js';

export function computeFindingSignature(
  finding: Pick<StructuredFinding, 'type' | 'code' | 'path'>,
): string {
  let normalizedPath = '';
  if (finding.path) {
    const result = normalizePath(finding.path);
    normalizedPath = result.ok ? result.path : '';
  }
  const payload = `${finding.type}\n${finding.code}\n${normalizedPath}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function withFindingSignature(finding: StructuredFinding): StructuredFinding {
  return {
    ...finding,
    signature: computeFindingSignature(finding),
  };
}
