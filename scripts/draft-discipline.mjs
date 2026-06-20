import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContractEvidence } from './contract-evidence.mjs';

const require = createRequire(import.meta.url);
const taxonomy = require('./draft-discipline-action-taxonomy.json');

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
const DEFAULT_ISSUE_REPO = 'chetwerikoff/orchestrator-pack';

function normalizeLine(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function parseKeyValueBlock(body) {
  const result = {};
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

export function extractFencedBlocks(markdown) {
  const blocks = new Map();
  let match;
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

export function parseBehaviorKind(markdown) {
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

export function parsePositiveOutcomeBlocks(markdown) {
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

export function parseParkedRootBlocks(markdown) {
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

export function countActionTaxonomyHits(markdown, terms = taxonomy.terms) {
  const lower = markdown.toLowerCase();
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
}

function isVagueCause(cause) {
  const normalized = normalizeLine(cause);
  if (normalized.length < 20) {
    return true;
  }
  return VAGUE_CAUSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function parseIssueNumber(reference) {
  const match = reference.match(/#(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function issueBodyContainsCause(issueBody, cause) {
  const normalizedCause = normalizeLine(cause).toLowerCase();
  if (!normalizedCause) {
    return false;
  }
  const normalizedBody = normalizeLine(issueBody).toLowerCase();
  return normalizedBody.includes(normalizedCause);
}

function stripFencedBlocks(markdown, kind) {
  const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('```' + escaped + '\\s*\\r?\\n[\\s\\S]*?```', 'gi');
  return markdown.replace(pattern, '');
}

export function detectDeferralWithoutBlock(markdown) {
  const withoutParkedBlocks = stripFencedBlocks(markdown, 'parked-root-cause');
  return DEFERRAL_WITHOUT_BLOCK_PATTERNS.some((pattern) => pattern.test(withoutParkedBlocks));
}

export function checkPositiveOutcome(markdown) {
  const behaviorKind = parseBehaviorKind(markdown);
  if (!behaviorKind) {
    return { ok: true, errors: [], warnings: [], behaviorKind: null, skipped: true };
  }

  const errors = [];
  const warnings = [];
  const positiveBlocks = parsePositiveOutcomeBlocks(markdown);
  const taxonomyHits = countActionTaxonomyHits(markdown);

  if (behaviorKind === 'record-only' && taxonomyHits.length > 0) {
    errors.push(
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

export function normalizeLiveIssue(parsed) {
  const state = parsed.state === 'OPEN' ? 'OPEN' : 'CLOSED';
  const closedByPr = Array.isArray(parsed.closedByPullRequestsReferences)
    && parsed.closedByPullRequestsReferences.length > 0;
  const intentionallyResolved = state === 'CLOSED'
    && (parsed.stateReason === 'COMPLETED' || closedByPr);
  return {
    state,
    title: parsed.title ?? '',
    body: parsed.body ?? '',
    intentionallyResolved,
  };
}

export function fetchLiveIssue(issueNumber, repo = process.env.GITHUB_REPOSITORY || DEFAULT_ISSUE_REPO) {
  try {
    const output = execFileSync(
      'gh',
      [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'state,stateReason,title,body,closedByPullRequestsReferences',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return normalizeLiveIssue(JSON.parse(output));
  } catch {
    return null;
  }
}

export function resolveParkedRootIssueMap(blocks, mockIssues = {}, options = {}) {
  const fetchLive = options.fetchLive ?? false;
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_ISSUE_REPO;
  const map = { ...mockIssues };
  if (!fetchLive) {
    return map;
  }
  for (const block of blocks) {
    const issueNumber = parseIssueNumber(block.followUpIssue);
    if (!issueNumber) {
      continue;
    }
    const key = String(issueNumber);
    if (map[key]) {
      continue;
    }
    const live = fetchLiveIssue(issueNumber, repo);
    if (live) {
      map[key] = live;
    }
  }
  return map;
}

export function checkParkedRoot(markdown, mockIssues = {}) {
  const errors = [];
  const warnings = [];
  const blocks = parseParkedRootBlocks(markdown);
  const deferralWithoutBlock = detectDeferralWithoutBlock(markdown);

  if (deferralWithoutBlock) {
    errors.push('draft defers a root cause without a ```parked-root-cause``` structured block');
  }

  for (const block of blocks) {
    const requiredFields = [
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
      errors.push(
        `follow-up issue #${issueNumber} could not be validated (not found, inaccessible, or gh issue view failed)`,
      );
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

export function checkRcaSpecDisciplineSurfaces(repoRoot, configPath) {
  const configFile =
    configPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'rca-spec-discipline-surfaces.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));

  const errors = [];
  for (const rule of config.rules) {
    for (const surface of rule.surfaces) {
      const absolute = path.join(repoRoot, surface);
      let content;
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
      let content;
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

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('draft-discipline.mjs'));
}

export function runCli(argv) {
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
  let mockIssues = {};
  if (mockFlag >= 0) {
    mockIssues = JSON.parse(readFileSync(argv[mockFlag + 1], 'utf8'));
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
    const blocks = parseParkedRootBlocks(markdown);
    const issueMap = resolveParkedRootIssueMap(blocks, mockIssues, {
      fetchLive: mockFlag < 0,
    });
    const result = checkParkedRoot(markdown, issueMap);
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

  if (command === 'contract-evidence') {
    const repoRoot = repoRootFlag >= 0 ? argv[repoRootFlag + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifestFlag = argv.indexOf('--manifest');
    const legacyFlag = argv.indexOf('--legacy-list');
    const result = checkContractEvidence(markdown, {
      repoRoot,
      draftPath,
      manifestPath: manifestFlag >= 0 ? argv[manifestFlag + 1] : undefined,
      legacyListPath: legacyFlag >= 0 ? argv[legacyFlag + 1] : undefined,
    });
    if (!result.ok) {
      for (const error of result.errors) {
        process.stderr.write(`draft-discipline: ${error}\n`);
      }
      return 1;
    }
    process.stdout.write('draft-discipline contract-evidence: PASS\n');
    return 0;
  }

  process.stderr.write('draft-discipline: unknown command (positive-outcome | parked-root | contract-evidence | surfaces)\n');
  return 2;
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
