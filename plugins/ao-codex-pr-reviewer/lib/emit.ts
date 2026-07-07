import { withFindingSignature } from '@orchestrator-pack/ao-token-chain-ledger/lib/finding_signature.js';
import type { AoReviewFinding, ReviewSource, StructuredFinding } from './types.js';

function mapSeverity(severity: string): AoReviewFinding['severity'] {
  if (severity === 'blocking') {
    return 'error';
  }
  if (severity === 'non-blocking') {
    return 'warning';
  }
  switch (severity) {
    case 'error':
    case 'warning':
    case 'info':
      return severity;
    default:
      return 'warning';
  }
}

function formatFindingBody(finding: StructuredFinding): string {
  const lines = [
    `type: ${finding.type}`,
    `code: ${finding.code}`,
    `severity: ${finding.severity}`,
    `path: ${finding.path ?? '(none)'}`,
    `summary: ${finding.summary}`,
    `source: ${finding.source}`,
  ];
  if (finding.signature) {
    lines.push(`signature: ${finding.signature}`);
  }
  if (finding.details) {
    lines.push('', 'details:', finding.details);
  }
  if (finding.suggested_fix) {
    lines.push('', 'suggested_fix:', finding.suggested_fix);
  }
  return lines.join('\n');
}

export function toAoFindings(findings: StructuredFinding[]): AoReviewFinding[] {
  return findings.map((finding) => {
    const signed = withFindingSignature(finding);
    const marker =
      finding.type === 'scope-violation' ? `[scope-violation] ` : '';
    return {
      severity: mapSeverity(String(finding.severity)),
      title: truncate(`${marker}${finding.summary}`, 160),
      body: formatFindingBody(signed),
      filePath: finding.path ?? undefined,
      category: String(finding.type),
      fingerprint: signed.signature,
    };
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export type TerminalVerdict = 'clean' | 'findings';

export interface TerminalVerdictPayload {
  verdict: TerminalVerdict;
  findingCount: number;
  findings: AoReviewFinding[];
}

export function emitTerminalVerdictPayload(options: {
  verdict: TerminalVerdict;
  findings: AoReviewFinding[];
}): string {
  return JSON.stringify({
    verdict: options.verdict,
    findingCount: options.findings.length,
    findings: options.findings,
  });
}

export function emitAoReviewPayload(findings: AoReviewFinding[]): string {
  return emitTerminalVerdictPayload({ verdict: 'findings', findings });
}

export function parseTerminalVerdictPayload(stdout: string): TerminalVerdictPayload | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<TerminalVerdictPayload>;
    if (parsed.verdict !== 'clean' && parsed.verdict !== 'findings') {
      return null;
    }
    if (typeof parsed.findingCount !== 'number' || !Number.isFinite(parsed.findingCount)) {
      return null;
    }
    if (!Array.isArray(parsed.findings)) {
      return null;
    }
    return parsed as TerminalVerdictPayload;
  } catch {
    return null;
  }
}

export function isCleanTerminalVerdict(stdout: string): boolean {
  return parseTerminalVerdictPayload(stdout)?.verdict === 'clean';
}

export function formatGithubComment(options: {
  model: string;
  findings: StructuredFinding[];
  /** True when Codex returned NO_FINDINGS (findings may still include scope warnings). */
  clean: boolean;
}): string {
  if (options.findings.length === 0) {
    return ['## Codex Review — no findings', ''].join('\n');
  }

  const lines = [`## Codex Review (${options.model})`, ''];
  for (const finding of options.findings) {
    const signed = withFindingSignature(finding);
    const marker =
      finding.type === 'scope-violation' ? '[scope-violation] ' : '';
    lines.push(
      `### ${marker}${finding.summary}`,
      '',
      '```json',
      JSON.stringify(signed, null, 2),
      '```',
      '',
    );
  }

  lines.push(
    '---',
    '_Automated review by Codex CLI · [orchestrator-pack](https://github.com/chetwerikoff/orchestrator-pack) · Never auto-merges_',
  );
  return lines.join('\n');
}

export function defaultSourceFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewSource {
  return env.GITHUB_ACTIONS === 'true' ? 'codex-github-action' : 'codex-local';
}
