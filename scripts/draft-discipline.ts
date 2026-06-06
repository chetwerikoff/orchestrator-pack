import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import taxonomy from './draft-discipline-action-taxonomy.json' with { type: 'json' };

export type BehaviorKind = 'action-producing' | 'record-only';

export interface PositiveOutcomeBlock {
  asserts?: string;
  input?: string;
  provenance?: string;
  raw: string;
}

export interface ParkedRootBlock {
  cause: string;
  evidence: string;
  reasonDeferred: string;
  followUpIssue: string;
  resolutionPolicy: string;
  raw: string;
}

export interface MockIssue {
  state: 'OPEN' | 'CLOSED';
  title: string;
  body: string;
  intentionallyResolved?: boolean;
}

export interface PositiveOutcomeCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  behaviorKind: BehaviorKind | null;
  skipped: boolean;
}

export interface ParkedRootCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  blocks: ParkedRootBlock[];
  deferralWithoutBlock: boolean;
}

const FENCE_PATTERN = /```([a-z0-9-]+)\s*\r?\n([\s\S]*?)```/gi;

const DEFERRAL_WITHOUT_BLOCK_PATTERNS = [
  /defer(?:red|ring)?\s+(?:the\s+)?(?:suspected\s+)?root[- ]cause/i,
  /root[- ]cause.{0,160}defer(?:red|red to|ring)?/i,
  /park(?:ed|ing)?\s+(?:the\s+)?root[- ]cause/i,
  /suspected root[- ]cause.{0,120}future (?:task|issue)/i,
  /root[- ]cause.{0,80}separate (?:task|issue)/i,
];

const VAGUE_CAUSE_PATTERNS = [
  /^tbd$/i,
  /^todo$/i,
  /^n\/a$/i,
  /^unknown$/i,
  /^placeholder$/i,
  /^see issue$/i,
  /^see follow[- ]up$/i,
  /^to be determined$/i,
];

const PLACEHOLDER_ISSUE_TITLE_PATTERNS = [
  /^todo$/i,
  /^tbd$/i,
  /^follow[- ]?up$/i,
  /^placeholder$/i,
  /^future (?:work|task)$/i,
  /^misc$/i,
  /^generic$/i,
];

const REALISTIC_INPUT_VALUES = new Set(['realistic', 'production-representative']);
const EXTERNAL_TOOL_INPUT = 'external-tool-output';
const VALID_PROVENANCE = new Set(['capture-backed', 'sample-backed']);

function normalizeLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function parseKeyValueBlock(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (match) {
      const key = match[1].toLowerCase().replace(/_/g, '-');
      result[key] = normalizeLine(match[2]);
    }
  }
  return result;
}

export function extractFencedBlocks(markdown: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);
  while ((match = pattern.exec(markdown)) !== null) {
    const kind = match[1].toLowerCase();
    const body = match[2].trim();
    const existing = blocks.get(kind) ?? [];
    existing.push(body);
    blocks.set(kind, existing);
  }
  return blocks;
}

export function parseBehaviorKind(markdown: string): BehaviorKind | null {
  const blocks = extractFencedBlocks(markdown);
  const raw = blocks.get('behavior-kind')?.[0]?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'action-producing' || raw.includes('action-producing')) {
    return 'action-producing';
  }
  if (raw === 'record-only' || raw.includes('record-only')) {
    return 'record-only';
  }
  return null;
}

export function parsePositiveOutcomeBlocks(markdown: string): PositiveOutcomeBlock[] {
  const blocks = extractFencedBlocks(markdown);
  return (blocks.get('positive-outcome') ?? []).map((raw) => {
    const fields = parseKeyValueBlock(raw);
    return {
      asserts: fields.asserts,
      input: fields.input,
      provenance: fields.provenance,
      raw,
    };
  });
}

export function parseParkedRootBlocks(markdown: string): ParkedRootBlock[] {
  const blocks = extractFencedBlocks(markdown);
  return (blocks.get('parked-root-cause') ?? []).map((raw) => {
    const fields = parseKeyValueBlock(raw);
    return {
      cause: fields.cause ?? '',
      evidence: fields.evidence ?? '',
      reasonDeferred: fields['reason-deferred'] ?? fields.reason ?? '',
      followUpIssue: fields['follow-up-issue'] ?? fields.issue ?? '',
      resolutionPolicy: fields['resolution-policy'] ?? fields.policy ?? '',
      raw,
    };
  });
}

export function countActionTaxonomyHits(markdown: string, terms: string[] = taxonomy.terms): string[] {
  const lower = markdown.toLowerCase();
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
}

function isVagueCause(cause: string): boolean {
  const normalized = normalizeLine(cause);
  if (normalized.length < 20) {
    return true;
  }
  return VAGUE_CAUSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function parseIssueNumber(reference: string): number | null {
  const match = reference.match(/#(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function issueBodyContainsCause(issueBody: string, cause: string): boolean {
  const normalizedCause = normalizeLine(cause).toLowerCase();
  if (!normalizedCause) {
    return false;
  }
  const normalizedBody = normalizeLine(issueBody).toLowerCase();
  if (normalizedBody.includes(normalizedCause)) {
    return true;
  }
  const significant = normalizedCause.split(' ').filter((word) => word.length > 4);
  if (significant.length === 0) {
    return false;
  }
  const hits = significant.filter((word) => normalizedBody.includes(word));
  return hits.length >= Math.min(3, significant.length);
}

export function detectDeferralWithoutBlock(markdown: string): boolean {
  if (parseParkedRootBlocks(markdown).length > 0) {
    return false;
  }
  return DEFERRAL_WITHOUT_BLOCK_PATTERNS.some((pattern) => pattern.test(markdown));
}

export function checkPositiveOutcome(markdown: string): PositiveOutcomeCheckResult {
  const behaviorKind = parseBehaviorKind(markdown);
  if (!behaviorKind) {
    return { ok: true, errors: [], warnings: [], behaviorKind: null, skipped: true };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const positiveBlocks = parsePositiveOutcomeBlocks(markdown);
  const taxonomyHits = countActionTaxonomyHits(markdown);

  if (behaviorKind === 'record-only' && taxonomyHits.length > 0) {
    warnings.push(
      `behavior-kind is record-only but draft reads action-producing (taxonomy hits: ${taxonomyHits.join(', ')})`,
    );
  }

  if (behaviorKind !== 'action-producing') {
    return { ok: errors.length === 0, errors, warnings, behaviorKind, skipped: false };
  }

  if (positiveBlocks.length === 0) {
    errors.push('action-producing draft lacks a ```positive-outcome``` acceptance block');
    return { ok: false, errors, warnings, behaviorKind, skipped: false };
  }

  const validPositive = positiveBlocks.some((block) => {
    if (!block.asserts) {
      return false;
    }
    const input = block.input?.toLowerCase();
    if (!input || !REALISTIC_INPUT_VALUES.has(input)) {
      if (input === EXTERNAL_TOOL_INPUT) {
        const provenance = block.provenance?.toLowerCase();
        return Boolean(provenance && VALID_PROVENANCE.has(provenance));
      }
      return false;
    }
    return true;
  });

  if (!validPositive) {
    errors.push(
      'action-producing draft needs a positive-outcome block with input: realistic (or input: external-tool-output plus capture-backed/sample-backed provenance)',
    );
  }

  for (const block of positiveBlocks) {
    if (block.input?.toLowerCase() === EXTERNAL_TOOL_INPUT) {
      const provenance = block.provenance?.toLowerCase();
      if (!provenance || !VALID_PROVENANCE.has(provenance)) {
        errors.push(
          'positive-outcome block with external-tool input must declare provenance: capture-backed or sample-backed',
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, behaviorKind, skipped: false };
}

export function checkParkedRoot(
  markdown: string,
  mockIssues: Record<string, MockIssue> = {},
): ParkedRootCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blocks = parseParkedRootBlocks(markdown);
  const deferralWithoutBlock = detectDeferralWithoutBlock(markdown);

  if (deferralWithoutBlock) {
    errors.push('draft defers a root cause without a ```parked-root-cause``` structured block');
  }

  for (const block of blocks) {
    const requiredFields: Array<[string, string]> = [
      ['cause', block.cause],
      ['evidence', block.evidence],
      ['reason-deferred', block.reasonDeferred],
      ['follow-up-issue', block.followUpIssue],
      ['resolution-policy', block.resolutionPolicy],
    ];
    for (const [name, value] of requiredFields) {
      if (!normalizeLine(value)) {
        errors.push(`parked-root-cause block missing required field: ${name}`);
      }
    }

    if (block.cause && isVagueCause(block.cause)) {
      errors.push('parked-root-cause cause is vague or placeholder');
    }

    const issueNumber = parseIssueNumber(block.followUpIssue);
    if (!issueNumber) {
      errors.push('parked-root-cause follow-up-issue must reference a GitHub issue number (#N)');
      continue;
    }

    const issue = mockIssues[String(issueNumber)];
    if (!issue) {
      warnings.push(`follow-up issue #${issueNumber} not validated (no mock/live issue data)`);
      continue;
    }

    if (PLACEHOLDER_ISSUE_TITLE_PATTERNS.some((pattern) => pattern.test(issue.title.trim()))) {
      errors.push(`follow-up issue #${issueNumber} title is a generic placeholder`);
    }

    if (issue.state === 'CLOSED' && !issue.intentionallyResolved) {
      errors.push(`follow-up issue #${issueNumber} is closed without intentional resolution`);
    }

    if (!issueBodyContainsCause(issue.body, block.cause)) {
      errors.push(`follow-up issue #${issueNumber} body does not carry the declared cause statement`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    blocks,
    deferralWithoutBlock,
  };
}

export interface SurfaceCheckResult {
  ok: boolean;
  errors: string[];
}

export function checkRcaSpecDisciplineSurfaces(
  repoRoot: string,
  configPath?: string,
): SurfaceCheckResult {
  const configFile =
    configPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'rca-spec-discipline-surfaces.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
    rules: Array<{ id: string; markers: string[]; surfaces: string[] }>;
    agentRulesMirrors?: string[];
  };

  const errors: string[] = [];
  for (const rule of config.rules) {
    for (const surface of rule.surfaces) {
      const absolute = path.join(repoRoot, surface);
      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        errors.push(`missing surface for rule ${rule.id}: ${surface}`);
        continue;
      }
      const missingMarkers = rule.markers.filter((marker) => !content.includes(marker));
      if (missingMarkers.length > 0) {
        errors.push(
          `rule ${rule.id} missing markers [${missingMarkers.join(', ')}] in ${surface}`,
        );
      }
    }
  }

  const agentRulesPath = path.join(repoRoot, 'prompts/agent_rules.md');
  let agentRules = '';
  try {
    agentRules = readFileSync(agentRulesPath, 'utf8');
  } catch {
    errors.push('missing prompts/agent_rules.md for mirror check');
  }

  if (agentRules && config.agentRulesMirrors) {
    for (const mirror of config.agentRulesMirrors) {
      const absolute = path.join(repoRoot, mirror);
      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        errors.push(`missing agent_rules mirror: ${mirror}`);
        continue;
      }
      if (!content.includes('agent_rules.md') && !content.includes('RCA spec discipline')) {
        errors.push(`mirror ${mirror} does not point at agent_rules.md or RCA spec discipline`);
      }
    }
  }

  const cursorSkillsRoot = path.join(repoRoot, '.cursor/skills');
  for (const rule of config.rules) {
    for (const surface of rule.surfaces) {
      if (!surface.startsWith('.claude/skills/')) {
        continue;
      }
      const skillName = surface.split('/')[2];
      const pointerPath = path.join(cursorSkillsRoot, skillName, 'SKILL.md');
      try {
        const pointer = readFileSync(pointerPath, 'utf8');
        if (!pointer.includes('.claude/skills/')) {
          errors.push(`cursor skill pointer missing canonical link: ${pointerPath}`);
        }
      } catch {
        errors.push(`missing generated cursor skill pointer: ${pointerPath}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function isCliMain(): boolean {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('draft-discipline.ts') || entry?.endsWith('check-draft-discipline.ts'));
}

export function runCli(argv: string[]): number {
  const command = argv[2];
  const draftFlag = argv.indexOf('--draft');
  const mockFlag = argv.indexOf('--mock-issues');
  const repoRootFlag = argv.indexOf('--repo-root');

  if (command === 'surfaces') {
    const repoRoot = repoRootFlag >= 0 ? argv[repoRootFlag + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = checkRcaSpecDisciplineSurfaces(repoRoot);
    if (!result.ok) {
      for (const error of result.errors) {
        process.stderr.write(`draft-discipline: ${error}\n`);
      }
      return 1;
    }
    process.stdout.write('draft-discipline surfaces: PASS\n');
    return 0;
  }

  if (draftFlag < 0) {
    process.stderr.write('draft-discipline: --draft <path> is required\n');
    return 2;
  }

  const draftPath = argv[draftFlag + 1];
  const markdown = readFileSync(draftPath, 'utf8');
  let mockIssues: Record<string, MockIssue> = {};
  if (mockFlag >= 0) {
    mockIssues = JSON.parse(readFileSync(argv[mockFlag + 1], 'utf8')) as Record<string, MockIssue>;
  }

  if (command === 'positive-outcome') {
    const result = checkPositiveOutcome(markdown);
    for (const warning of result.warnings) {
      process.stderr.write(`draft-discipline warning: ${warning}\n`);
    }
    if (!result.ok) {
      for (const error of result.errors) {
        process.stderr.write(`draft-discipline: ${error}\n`);
      }
      return 1;
    }
    process.stdout.write('draft-discipline positive-outcome: PASS\n');
    return 0;
  }

  if (command === 'parked-root') {
    const result = checkParkedRoot(markdown, mockIssues);
    for (const warning of result.warnings) {
      process.stderr.write(`draft-discipline warning: ${warning}\n`);
    }
    if (!result.ok) {
      for (const error of result.errors) {
        process.stderr.write(`draft-discipline: ${error}\n`);
      }
      return 1;
    }
    process.stdout.write('draft-discipline parked-root: PASS\n');
    return 0;
  }

  process.stderr.write('draft-discipline: unknown command (positive-outcome | parked-root | surfaces)\n');
  return 2;
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
