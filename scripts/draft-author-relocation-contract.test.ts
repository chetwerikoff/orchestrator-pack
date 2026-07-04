import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkRelocationContractSurfaces,
  validateCompletionRecord,
  validateDelegateResult,
} from './draft-author-relocation-contract.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('validateCompletionRecord', () => {
  const valid = {
    briefIdentity: 'brief-579',
    draftPath: 'docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md',
    authoringEngine: 'cursor',
    selectionBasis: 'default',
    tierResult: 'T3',
    reviewLoopOutcome: 'NO_FINDINGS',
    dispositionStatus: 'n/a',
    disciplineChecks: 'pass',
    finalStatus: 'complete',
  };

  it('accepts a complete record with Cursor default engine', () => {
    const result = validateCompletionRecord(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects non-Cursor engine without explicit-request basis', () => {
    const result = validateCompletionRecord({
      ...valid,
      authoringEngine: 'codex',
      selectionBasis: 'default',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/explicit-request/);
  });

  it('accepts Codex when selection basis is explicit-request', () => {
    const result = validateCompletionRecord({
      ...valid,
      authoringEngine: 'codex',
      selectionBasis: 'explicit-request',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unrecognized authoring engines', () => {
    const result = validateCompletionRecord({
      ...valid,
      authoringEngine: 'claude',
      selectionBasis: 'default',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unrecognized authoringEngine/);
  });

  it('rejects draft paths outside docs/issues_drafts', () => {
    const result = validateCompletionRecord({
      ...valid,
      draftPath: 'README.md',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/docs\/issues_drafts/);
  });

  it('rejects draft paths with traversal segments escaping the draft directory', () => {
    const result = validateCompletionRecord({
      ...valid,
      draftPath: 'docs/issues_drafts/../outside.md',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/docs\/issues_drafts/);
  });

  it('rejects completion records missing dispositionStatus', () => {
    const { dispositionStatus: _omit, ...withoutDisposition } = valid;
    const result = validateCompletionRecord(withoutDisposition);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/dispositionStatus/);
  });

  it('rejects invalid selectionBasis values', () => {
    const result = validateCompletionRecord({
      ...valid,
      selectionBasis: 'defualt',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/invalid selectionBasis/);
  });
});

describe('validateDelegateResult', () => {
  const completionRecord = {
    briefIdentity: 'brief-579',
    draftPath: 'docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md',
    authoringEngine: 'cursor',
    selectionBasis: 'default',
    tierResult: 'T2',
    reviewLoopOutcome: 'NO_FINDINGS',
    dispositionStatus: 'n/a',
    disciplineChecks: 'pass',
    finalStatus: 'complete',
  };

  it('rejects exit 0 without draft path or completion proof', () => {
    const result = validateDelegateResult({ exitCode: 0 });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/draftPath|completion record/);
  });

  it('rejects exit 0 when draft is reported missing', () => {
    const result = validateDelegateResult({
      exitCode: 0,
      draftPath: 'docs/issues_drafts/missing.md',
      draftExists: false,
      completionRecord,
      disciplineChecksPass: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/draft missing/);
  });

  it('accepts exit 0 with draft and complete completion record', () => {
    const result = validateDelegateResult({
      exitCode: 0,
      draftPath: completionRecord.draftPath,
      draftExists: true,
      completionRecord,
      disciplineChecksPass: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects exit 0 when delegate draftPath differs from completion record', () => {
    const result = validateDelegateResult({
      exitCode: 0,
      draftPath: 'docs/issues_drafts/other-draft.md',
      draftExists: true,
      completionRecord,
      disciplineChecksPass: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/does not match completion record draftPath/);
  });

  it('rejects exit 0 when delegate draftPath uses traversal to escape the draft directory', () => {
    const result = validateDelegateResult({
      exitCode: 0,
      draftPath: 'docs/issues_drafts/../outside.md',
      draftExists: true,
      completionRecord,
      disciplineChecksPass: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/path traversal|docs\/issues_drafts/);
  });
});

describe('checkRelocationContractSurfaces', () => {
  it('passes on the repository contract surfaces', () => {
    const result = checkRelocationContractSurfaces(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
