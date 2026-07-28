import { parseKeyValueBlock } from './markdown-key-value.mjs';

function parseBehaviorKind(markdown) {
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

const FENCE_PATTERN = /```([a-z0-9-]+)\s*\r?\n([\s\S]*?)```/gi;

function extractFencedBlocks(markdown) {
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

function parseScenarioLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) {
    return null;
  }
  const actionMatch = trimmed.match(/action:\s*(.+?)(?:\s*\|\s*expected:\s*(.+))?$/i);
  if (actionMatch) {
    return {
      action: actionMatch[1].trim(),
      expected: (actionMatch[2] ?? '').trim(),
    };
  }
  const parts = trimmed.replace(/^-\s*/, '').split(/\s*\|\s*/);
  if (parts.length >= 2) {
    return { action: parts[0].trim(), expected: parts[1].trim() };
  }
  return null;
}

export function parseSmokeTestPlan(markdown) {
  const blocks = extractFencedBlocks(markdown);
  const raw = blocks.get('smoke-test-plan')?.[0];
  if (!raw) {
    return null;
  }
  const fields = parseKeyValueBlock(raw);
  const notApplicable = ['true', 'yes', '1'].includes(String(fields['not-applicable'] ?? fields.na ?? '').toLowerCase());
  if (notApplicable) {
    return {
      requirement: 'not-applicable',
      reason: fields.reason?.trim() || fields['n/a-reason']?.trim() || '',
      scenarios: [],
    };
  }

  const scenarios = [];
  for (const line of raw.split(/\r?\n/u)) {
    const scenario = parseScenarioLine(line);
    if (scenario?.action && scenario.expected) {
      scenarios.push(scenario);
    }
  }

  return {
    requirement: 'required',
    scenarios,
  };
}

export function resolveSmokeRequirement(markdown) {
  const parsed = parseSmokeTestPlan(markdown);
  if (!parsed) {
    return { requirement: 'legacy-exempt', scenarios: [] };
  }
  return parsed;
}

export function checkSmokeTestPlan(markdown) {
  const errors = [];
  const warnings = [];
  const behaviorKind = parseBehaviorKind(markdown);
  const blocks = extractFencedBlocks(markdown);
  const hasFence = blocks.has('smoke-test-plan');

  if (!hasFence) {
    if (behaviorKind === 'action-producing') {
      errors.push('action-producing task lacks a ```smoke-test-plan``` block');
    }
    return { ok: errors.length === 0, errors, warnings, plan: null };
  }

  const plan = parseSmokeTestPlan(markdown);
  if (!plan) {
    errors.push('smoke-test-plan fence is present but could not be parsed');
    return { ok: false, errors, warnings, plan: null };
  }

  if (plan.requirement === 'not-applicable') {
    if (!plan.reason || plan.reason.length < 8) {
      errors.push('smoke-test-plan not-applicable requires a one-line reason of at least 8 characters');
    }
    return { ok: errors.length === 0, errors, warnings, plan };
  }

  if (plan.scenarios.length === 0) {
    errors.push('smoke-test-plan must list at least one scenario with action and expected result, or declare not-applicable with reason');
    return { ok: false, errors, warnings, plan };
  }

  for (const [index, scenario] of plan.scenarios.entries()) {
    if (!scenario.action.trim()) {
      errors.push(`smoke-test-plan scenario ${index + 1} is missing action`);
    }
    if (!scenario.expected.trim()) {
      errors.push(`smoke-test-plan scenario ${index + 1} is missing expected observable result`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, plan };
}
