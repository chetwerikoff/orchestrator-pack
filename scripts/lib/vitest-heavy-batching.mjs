#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { collectFromVitestJson, normalizeFilePath } from './vitest-json-report.mjs';

export const DEFAULT_NON_ISOLATE_FILE_BATCH_SIZE = 4;
export const DEFAULT_ISOLATE_TEST_BATCH_SIZE = 1;
export const HEAVY_BATCHING_REDUCTION_TARGET = {
  representativeShard: 'largest non-isolate heavy shard',
  minimumInvocationReductionPercent: 25,
  minimumBootTimeReductionPercent: 25,
  bootAttributionMethod: 'compare planned invocation count multiplied by measured median npm/vitest process boot seconds',
  wallTimeNoiseTolerancePercent: 10,
};

export function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function buildHeavyInvocationUnits(filePlans) {
  const units = [];
  for (const plan of filePlans) {
    const file = String(plan.file ?? '').replace(/\\/g, '/');
    const pool = String(plan.pool ?? 'threads');
    if (plan.mode === 'tests') {
      for (const testTitle of plan.tests ?? []) {
        units.push({
          kind: 'test',
          file,
          pool,
          testPattern: String(testTitle),
          label: `${file} > ${testTitle}`,
          batchable: false,
        });
      }
      continue;
    }
    units.push({
      kind: 'file',
      file,
      pool,
      testPattern: null,
      label: file,
      batchable: plan.batchable !== false,
    });
  }
  return units;
}

export function groupHeavyInvocationUnits(units, options = {}) {
  const nonIsolateFileBatchSize = parsePositiveInteger(
    options.nonIsolateFileBatchSize,
    DEFAULT_NON_ISOLATE_FILE_BATCH_SIZE,
  );
  const isolateTestBatchSize = parsePositiveInteger(
    options.isolateTestBatchSize,
    DEFAULT_ISOLATE_TEST_BATCH_SIZE,
  );
  const batches = [];
  let openFileBatch = null;

  function flushOpenFileBatch() {
    if (!openFileBatch) {
      return;
    }
    batches.push(materializeBatch(openFileBatch));
    openFileBatch = null;
  }

  for (const unit of units) {
    if (unit.kind === 'test') {
      flushOpenFileBatch();
      const size = Math.min(isolateTestBatchSize, DEFAULT_ISOLATE_TEST_BATCH_SIZE);
      batches.push(materializeBatch({ pool: unit.pool, members: [unit], maxSize: size }));
      continue;
    }

    if (unit.batchable === false) {
      flushOpenFileBatch();
      batches.push(materializeBatch({ pool: unit.pool, members: [unit], maxSize: 1 }));
      continue;
    }

    if (
      !openFileBatch ||
      openFileBatch.pool !== unit.pool ||
      openFileBatch.members.length >= nonIsolateFileBatchSize
    ) {
      flushOpenFileBatch();
      openFileBatch = { pool: unit.pool, members: [], maxSize: nonIsolateFileBatchSize };
    }
    openFileBatch.members.push(unit);
  }
  flushOpenFileBatch();
  return batches;
}

export function materializeBatch(batch) {
  const members = batch.members.map((member) => ({ ...member }));
  const files = [...new Set(members.map((member) => member.file))];
  const label = members.length === 1
    ? members[0].label
    : `batch(${members.length}): ${members.map((member) => member.label).join(', ')}`;
  return {
    label,
    pool: batch.pool,
    files,
    testPattern: members.length === 1 ? members[0].testPattern : null,
    members,
  };
}

export function countBaselineInvocations(units) {
  return units.length;
}

export function countBatchedInvocations(batches) {
  return batches.length;
}

export function validateHeavyBatchReportPayload(payload, plannedMembers, repoRoot) {
  const collected = collectFromVitestJson(payload, repoRoot);
  if (!collected) {
    return { ok: false, errors: ['report missing testResults array'] };
  }
  const expectedFiles = plannedMembers.map((member) => String(member.file).replace(/\\/g, '/'));
  const expectedFileSet = new Set(expectedFiles);
  const actualFiles = (payload.testResults ?? []).map((fileResult) =>
    normalizeFilePath(fileResult.name, repoRoot),
  );
  const actualFileSet = new Set(actualFiles);
  const errors = [];

  for (const file of expectedFileSet) {
    if (!actualFileSet.has(file)) {
      errors.push(`missing reported file: ${file}`);
    }
  }
  for (const file of actualFileSet) {
    if (!expectedFileSet.has(file)) {
      errors.push(`unexpected reported file: ${file}`);
    }
  }
  for (const file of actualFileSet) {
    const occurrences = actualFiles.filter((actual) => actual === file).length;
    if (occurrences > 1 && expectedFiles.filter((expected) => expected === file).length === 1) {
      errors.push(`duplicate reported file: ${file}`);
    }
  }

  for (const member of plannedMembers.filter((entry) => entry.kind === 'test')) {
    const matchingTests = collected.tests.filter((test) => {
      return test.file === member.file && test.name.includes(member.testPattern);
    });
    if (matchingTests.length === 0) {
      errors.push(`missing reported test: ${member.file} > ${member.testPattern}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateHeavyBatchReportFile(reportPath, plannedMembers, repoRoot) {
  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  return validateHeavyBatchReportPayload(payload, plannedMembers, repoRoot);
}

function parseValidateCli(argv) {
  if (argv[0] !== 'validate-report') {
    return null;
  }
  let reportPath = '';
  let repoRoot = process.cwd();
  let plannedJson = '';
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') {
      reportPath = argv[++index] ?? '';
    } else if (arg === '--repo-root') {
      repoRoot = argv[++index] ?? '';
    } else if (arg === '--planned-json') {
      plannedJson = argv[++index] ?? '';
    }
  }
  if (!reportPath || !plannedJson) {
    throw new Error('usage: node vitest-heavy-batching.mjs validate-report --report <path> --planned-json <json> [--repo-root <path>]');
  }
  const parsed = JSON.parse(plannedJson);
  return {
    reportPath,
    repoRoot,
    plannedMembers: Array.isArray(parsed) ? parsed : parsed.members,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = parseValidateCli(process.argv.slice(2));
  if (cli) {
    const result = validateHeavyBatchReportFile(cli.reportPath, cli.plannedMembers, cli.repoRoot);
    if (!result.ok) {
      process.stderr.write(`${result.errors.join('\n')}\n`);
      process.exit(1);
    }
  }
}
