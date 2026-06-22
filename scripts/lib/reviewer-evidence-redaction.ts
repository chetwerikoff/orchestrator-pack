const CREDENTIAL_EVIDENCE_REPLACEMENT = '[REDACTED_CREDENTIAL]';

const CREDENTIAL_EVIDENCE_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*\S+/gi,
  /(?:authorization|auth)\s*:\s*Bearer\s+\S+/gi,
  /Bearer\s+\S+/gi,
  /(?:cookie|set-cookie)\s*:\s*[^\n\r]+/gi,
  /(?:x-api-key|x-auth-token|x-amz-security-token)\s*:\s*\S+/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ASIA|AROA)[0-9A-Z]{16}\b/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghr_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:database_url|redis_url|mongodb(?:\+srv)?_url|amqp_url|postgres(?:ql)?|mysql|mariadb|mongodb):\/\/[^\s'"]+/gi,
  /\b[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|KEY)\s*=\s*\S+/g,
  /(?:^|\n)(?:\+ ?)?-----BEGIN (?:RSA |EC |OPENSSH )?(?:ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:\+ ?)?-----END (?:RSA |EC |OPENSSH )?(?:ENCRYPTED )?PRIVATE KEY-----/g,
];

export function redactCredentialFormatsFromEvidence(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_EVIDENCE_PATTERNS) {
    redacted = redacted.replace(pattern, CREDENTIAL_EVIDENCE_REPLACEMENT);
  }
  return redacted;
}
