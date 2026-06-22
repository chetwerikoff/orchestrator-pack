import { describe, expect, it } from 'vitest';
import { redactCredentialFormatsFromEvidence } from './lib/reviewer-evidence-redaction.js';

describe('reviewer evidence credential redaction', () => {
  it('redacts common GitHub and generic token formats', () => {
    const input = [
      'ghp_1234567890123456789012345678901234567890',
      'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop',
      'gho_1234567890123456789012345678901234567890',
      'token=super-secret-value',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
      'AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const redacted = redactCredentialFormatsFromEvidence(input);
    expect(redacted).not.toContain('ghp_1234567890123456789012345678901234567890');
    expect(redacted).not.toContain('github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop');
    expect(redacted).not.toContain('gho_1234567890123456789012345678901234567890');
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain('[REDACTED_CREDENTIAL]');
  });

  it('redacts PEM private key blocks', () => {
    const input = `prefix\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----\nsuffix`;
    const redacted = redactCredentialFormatsFromEvidence(input);
    expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(redacted).toContain('[REDACTED_CREDENTIAL]');
  });
});
