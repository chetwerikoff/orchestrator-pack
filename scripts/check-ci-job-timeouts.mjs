#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const WORKFLOW_TIMEOUT_POLICY = {
  '.github/workflows/scope-guard.yml': {
    references: {
      quick: { minutes: 5, margin: 2.0 },
      medium: { minutes: 7.5, margin: 2.0 },
      lightLane: { minutes: 10, margin: 2.0 },
      pester: { minutes: 10, margin: 2.0 },
      heavyShard: { minutes: 21.5, margin: 2.0 },
      verifyPack: { minutes: 13.65, margin: 2.0 },
      aggregate: { minutes: 13.65, margin: 2.0 },
      topologyPlan: { minutes: 10, margin: 2.0 },
    },
    jobs: {
      'classify-pr-changes': { timeout: 10, reference: 'quick' },
      'verify-pack': { timeout: 30, reference: 'verifyPack' },
      'pr-scope-guard': { timeout: 15, reference: 'medium' },
      'test-typecheck': { timeout: 15, reference: 'medium' },
      'test-vitest-light': { timeout: 20, reference: 'lightLane' },
      'plan-vitest-ci-topology': { timeout: 20, reference: 'topologyPlan' },
      'test-vitest-heavy': { timeout: 45, reference: 'heavyShard' },
      'test-pester': { timeout: 20, reference: 'pester' },
      'test-aggregate': { timeout: 30, reference: 'aggregate' },
      'self-architect-lint': { timeout: 10, reference: 'quick' },
    },
  },
  '.github/workflows/vitest-runtime-history-refresh.yml': {
    references: {
      heavyShard: { minutes: 21.5, margin: 2.0 },
      refresh: { minutes: 13.65, margin: 2.0 },
    },
    jobs: {
      'test-vitest-heavy': { timeout: 45, reference: 'heavyShard' },
      'refresh-runtime-history': { timeout: 30, reference: 'refresh' },
    },
  },
};

export function parseWorkflowJobs(text) {
  const lines = text.split(/\r?\n/);
  const rootKeys = new Map();
  const jobs = new Map();
  let inJobs = false;
  let currentJob = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (/^\s*(#|$)/.test(rawLine)) {
      continue;
    }
    const indent = rawLine.match(/^ */)[0].length;
    const keyMatch = rawLine.slice(indent).match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      continue;
    }
    const key = keyMatch[1];
    const value = keyMatch[2] ?? '';

    if (indent === 0) {
      if (rootKeys.has(key)) {
        throw new Error(`duplicate root key ${key} at line ${index + 1}`);
      }
      rootKeys.set(key, index + 1);
      inJobs = key === 'jobs';
      currentJob = null;
      continue;
    }

    if (!inJobs) {
      continue;
    }

    if (indent === 2) {
      if (jobs.has(key)) {
        throw new Error(`duplicate job key ${key} at line ${index + 1}`);
      }
      currentJob = { name: key, line: index + 1, keys: new Map(), timeoutMinutes: null };
      jobs.set(key, currentJob);
      continue;
    }

    if (indent === 4 && currentJob) {
      if (currentJob.keys.has(key)) {
        throw new Error(`duplicate key ${key} in job ${currentJob.name} at line ${index + 1}`);
      }
      currentJob.keys.set(key, index + 1);
      if (key === 'timeout-minutes') {
        const timeout = Number(String(value).trim());
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error(`invalid timeout-minutes for job ${currentJob.name} at line ${index + 1}`);
        }
        currentJob.timeoutMinutes = timeout;
      }
    }
  }

  if (!rootKeys.has('jobs')) {
    throw new Error('workflow missing jobs root key');
  }
  return [...jobs.values()];
}

export function verifyWorkflowTimeoutPolicy(path, text, policy = WORKFLOW_TIMEOUT_POLICY[path]) {
  if (!policy) {
    throw new Error(`missing timeout policy for ${path}`);
  }
  const jobs = parseWorkflowJobs(text);
  const errors = [];
  const expectedJobNames = Object.keys(policy.jobs).sort();
  const actualJobNames = jobs.map((job) => job.name).sort();
  if (expectedJobNames.join('\n') !== actualJobNames.join('\n')) {
    errors.push(`job set mismatch for ${path}: expected ${expectedJobNames.join(', ')}; actual ${actualJobNames.join(', ')}`);
  }

  for (const job of jobs) {
    const expected = policy.jobs[job.name];
    if (!expected) {
      continue;
    }
    if (job.timeoutMinutes === null) {
      errors.push(`job missing timeout-minutes: ${job.name}`);
      continue;
    }
    if (job.timeoutMinutes !== expected.timeout) {
      errors.push(`job ${job.name} timeout-minutes=${job.timeoutMinutes}; expected ${expected.timeout}`);
    }
    const reference = policy.references[expected.reference];
    if (!reference) {
      errors.push(`job ${job.name} references unknown runtime class ${expected.reference}`);
      continue;
    }
    const required = reference.minutes * reference.margin;
    if (job.timeoutMinutes < required) {
      errors.push(
        `job ${job.name} timeout ${job.timeoutMinutes} < reference ${reference.minutes} * margin ${reference.margin}`,
      );
    }
  }
  return { ok: errors.length === 0, errors, jobs };
}

export function verifyConfiguredWorkflowTimeouts(readFile = readFileSync) {
  const results = [];
  for (const path of Object.keys(WORKFLOW_TIMEOUT_POLICY)) {
    const text = readFile(path, 'utf8');
    results.push({ path, ...verifyWorkflowTimeoutPolicy(path, text) });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = verifyConfiguredWorkflowTimeouts();
  const errors = results.flatMap((result) => result.errors.map((error) => `${result.path}: ${error}`));
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exit(1);
  }
  for (const result of results) {
    process.stdout.write(`[PASS] ${result.path}: ${result.jobs.length} jobs declare checked timeout-minutes\n`);
  }
}
