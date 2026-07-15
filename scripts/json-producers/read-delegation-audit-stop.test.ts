import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPACT_JSON_NO_NEWLINE, COMPACT_JSON_WITH_NEWLINE, serializeGenericJsonArtifact, validateJsonValue } from '#opk-kernel/json-artifact';
import { buildReadDelegationAuditHealth, normalizeReadDelegationStopPayload } from './read-delegation-audit-stop.ts';

const root = join(import.meta.dirname, '..', '..', 'tests/external-output-references/variants/opk-json-producers/read-delegation-audit-stop');
const options = { artifactPath: '/tmp/audit.jsonl', homeDirectory: '/home/opk', env: { PACK_REVIEWER: 'codex', REVIEW_COMMAND: '' }, wrapperHash: 'a'.repeat(64) };

describe('read-delegation stop transform', () => {
  it('matches the normalized payload golden byte-for-byte', () => {
    const payload = normalizeReadDelegationStopPayload('{"hookEventName":"Stop","note":"café 茶\\nline"}', options);
    const actual = serializeGenericJsonArtifact(payload, COMPACT_JSON_NO_NEWLINE, 'fixture');
    expect(Buffer.from(actual).equals(readFileSync(join(root, 'payload.json')))).toBe(true);
  });

  it('matches the deterministic health JSONL golden', () => {
    const payload = normalizeReadDelegationStopPayload('{"hookEventName":"Stop","note":"café 茶\\nline"}', options);
    const health = buildReadDelegationAuditHealth(payload, 'audit module exited 1: boom', 1_767_225_600_123);
    const actual = serializeGenericJsonArtifact(validateJsonValue(health), COMPACT_JSON_WITH_NEWLINE, 'fixture');
    expect(Buffer.from(actual).equals(readFileSync(join(root, 'health.jsonl')))).toBe(true);
  });

  it('preserves supplied optional values and handles malformed input deterministically', () => {
    const supplied = normalizeReadDelegationStopPayload('{"surface":"cursor","env":{},"artifactPath":"x","hookWiringFingerprint":{}}', options);
    expect(supplied).toEqual({ surface: 'cursor', env: {}, artifactPath: '/tmp/audit.jsonl', hookWiringFingerprint: {} });
    const malformed = normalizeReadDelegationStopPayload('{', options);
    expect(malformed.parseError).toEqual(expect.any(String));
    expect(malformed.surface).toBe('cursor');
  });
});
