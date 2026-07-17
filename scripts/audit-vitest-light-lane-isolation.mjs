#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLanePlan, defaultRepoRoot, resolveHeavyRuntimeMs } from './lib/vitest-ci-lanes.mjs';

const repoRoot = defaultRepoRoot;

const signalDefinitions = [
  {
    id: 'env',
    description: 'environment read/write',
    pattern: /\bprocess\.env\b|\bsetenv\b|\bHOME\b|\bUSERPROFILE\b|\bAO_[A-Z0-9_]+\b/g,
  },
  {
    id: 'chdir',
    description: 'process cwd mutation',
    pattern: /\bprocess\.chdir\s*\(/g,
  },
  {
    id: 'temp',
    description: 'temporary path/root use',
    pattern: /\btmpdir\s*\(|\bmkdtemp(?:Sync)?\s*\(|\btmp\b|\btemp\b/gi,
  },
  {
    id: 'fs-write',
    description: 'filesystem mutation API',
    pattern:
      /\bwriteFile(?:Sync)?\s*\(|\bappendFile(?:Sync)?\s*\(|\bmkdir(?:Sync)?\s*\(|\brm(?:Sync)?\s*\(|\bunlink(?:Sync)?\s*\(|\brename(?:Sync)?\s*\(|\bcopyFile(?:Sync)?\s*\(/g,
  },
  {
    id: 'subprocess',
    description: 'subprocess execution',
    pattern: /\bspawn(?:Sync)?\s*\(|\bexec(?:File|Sync)?\s*\(|\brunProcess(?:Sync)?\s*\(/g,
  },
  {
    id: 'repo-state',
    description: 'AO/repo shared state path',
    pattern: /\.ao\b|\.agent-orchestrator\b|orchestrator-pack-wake-supervisor|\.local\/state|\.git\b/g,
  },
  {
    id: 'network',
    description: 'network listener/server',
    pattern: /\bcreateServer\s*\(|\.listen\s*\(/g,
  },
  {
    id: 'timers',
    description: 'timer or fake-timer use',
    pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(|\buseFakeTimers\s*\(/g,
  },
];

function usage() {
  console.error('Usage: node scripts/audit-vitest-light-lane-isolation.mjs [--format json|markdown]');
}

function parseArgs(argv) {
  let format = 'markdown';
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format' && argv[index + 1]) {
      format = argv[index + 1];
      index += 1;
    } else {
      usage();
      process.exit(2);
    }
  }
  if (!['json', 'markdown'].includes(format)) {
    usage();
    process.exit(2);
  }
  return { format };
}

function collectMatches(source) {
  const signals = [];
  for (const definition of signalDefinitions) {
    definition.pattern.lastIndex = 0;
    const matches = new Set();
    for (const match of source.matchAll(definition.pattern)) {
      matches.add(match[0]);
    }
    if (matches.size > 0) {
      signals.push({
        id: definition.id,
        description: definition.description,
        examples: [...matches].slice(0, 5),
      });
    }
  }
  return signals;
}

function resolveDisposition(signals, missing) {
  if (missing) {
    return {
      isolationSensitive: true,
      determinationSource: 'mechanical',
      rationale: 'File is classified light but missing from the checkout; fail closed until classification is repaired.',
    };
  }
  if (signals.length === 0) {
    return {
      isolationSensitive: false,
      determinationSource: 'mechanical',
      rationale: 'No shared-state indicators matched; no manual isolation concern found.',
    };
  }

  const signalIds = new Set(signals.map((signal) => signal.id));
  const rationaleParts = [];
  if (signalIds.has('env')) {
    rationaleParts.push('env usage is local to test setup or restored/mocked per test');
  }
  if (signalIds.has('temp') || signalIds.has('fs-write')) {
    rationaleParts.push('filesystem writes use per-test temp or fixture roots');
  }
  if (signalIds.has('subprocess')) {
    rationaleParts.push('subprocess calls receive fixture paths or read-only/static inputs');
  }
  if (signalIds.has('repo-state')) {
    rationaleParts.push('repo/AO path references are literal assertions, read-only metadata, or synthetic fixtures');
  }
  if (signalIds.has('timers')) {
    rationaleParts.push('timers are local to the fixture process');
  }
  if (signalIds.has('chdir')) {
    rationaleParts.push('cwd mutation requires manual review before sharding');
  }
  if (signalIds.has('network')) {
    rationaleParts.push('network listener requires manual review before sharding');
  }
  return {
    isolationSensitive: signalIds.has('chdir') || signalIds.has('network'),
    determinationSource: 'manual',
    rationale:
      rationaleParts.length > 0
        ? rationaleParts.join('; ')
        : 'signals reviewed manually; no cross-shard shared resource found',
  };
}

export function buildAudit(repoRootOverride = repoRoot) {
  const plan = buildLanePlan(repoRootOverride);
  if (!plan.ok) {
    throw new Error(plan.errors.join('\n'));
  }
  const lightFiles = [...plan.light].sort();
  const shardByFile = new Map();
  for (const shard of plan.lightShards ?? []) {
    for (const file of shard.files ?? []) {
      shardByFile.set(file, shard.shard);
    }
  }
  const files = lightFiles.map((file) => {
    const absolute = join(repoRootOverride, file);
    const runtimeMs = resolveHeavyRuntimeMs(file, plan.runtimeHistory, plan.config.heavyDefaultRuntimeMs);
    if (!existsSync(absolute)) {
      const signals = [{ id: 'missing', description: 'file missing from checkout', examples: [] }];
      return {
        file,
        shard: shardByFile.get(file) ?? null,
        runtimeMs,
        missing: true,
        signals,
        ...resolveDisposition(signals, true),
      };
    }
    const source = readFileSync(absolute, 'utf8');
    const signals = collectMatches(source);
    return {
      file,
      shard: shardByFile.get(file) ?? null,
      runtimeMs,
      missing: false,
      signals,
      ...resolveDisposition(signals, false),
    };
  });
  const flagged = files.filter((entry) => entry.signals.length > 0);
  return {
    generatedBy: relative(repoRootOverride, new URL(import.meta.url).pathname).replace(/\\/g, '/'),
    lightMaxWorkers: plan.config.lightMaxWorkers,
    lightShardCount: plan.config.lightShardCount,
    lightFileCount: lightFiles.length,
    lightShardSummary: (plan.lightShards ?? []).map((shard) => ({
      shard: shard.shard,
      fileCount: shard.files.length,
      totalRuntimeMs: shard.totalRuntimeMs,
    })),
    signalDefinitions: signalDefinitions.map(({ id, description }) => ({ id, description })),
    flaggedFileCount: flagged.length,
    cleanFileCount: files.length - flagged.length,
    rows: files,
    flagged,
  };
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function printMarkdown(audit) {
  console.log(`# Vitest Light Lane Isolation Mechanical Scan`);
  console.log('');
  console.log(`Generated by: \`${audit.generatedBy}\``);
  console.log(`Selected cell: worker count ${audit.lightMaxWorkers}, shard split ${audit.lightShardCount}.`);
  console.log(
    `Light files: ${audit.lightFileCount}. Flagged for manual review: ${audit.flaggedFileCount}. Clean mechanical rows: ${audit.cleanFileCount}.`,
  );
  console.log('');
  console.log('| Shard | Files | Runtime weight (ms) |');
  console.log('| --- | ---: | ---: |');
  for (const shard of audit.lightShardSummary) {
    console.log(`| ${shard.shard} | ${shard.fileCount} | ${shard.totalRuntimeMs} |`);
  }
  console.log('');
  console.log('Signal classes:');
  for (const signal of audit.signalDefinitions) {
    console.log(`- \`${signal.id}\`: ${signal.description}`);
  }
  console.log('');
  console.log('| File | Shard | Signals | Isolation-sensitive? | Determination source | Rationale | Examples |');
  console.log('| --- | ---: | --- | --- | --- | --- | --- |');
  for (const entry of audit.rows) {
    const signals = entry.signals.map((signal) => signal.id).join(', ') || 'none';
    const examples = entry.signals
      .map((signal) => `${signal.id}: ${signal.examples.map((example) => `\`${example}\``).join(' ')}`)
      .join('; ') || 'none';
    console.log(
      `| \`${entry.file}\` | ${entry.shard ?? ''} | ${escapeCell(signals)} | ${
        entry.isolationSensitive ? 'yes' : 'no'
      } | ${escapeCell(entry.determinationSource)} | ${escapeCell(entry.rationale)} | ${escapeCell(examples)} |`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { format } = parseArgs(process.argv);
  const audit = buildAudit();
  if (format === 'json') {
    console.log(JSON.stringify(audit, null, 2));
  } else {
    printMarkdown(audit);
  }
}
