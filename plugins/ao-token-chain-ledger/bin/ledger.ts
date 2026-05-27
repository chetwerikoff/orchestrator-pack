import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aggregateChain, formatChainReport } from '../lib/aggregate.js';
import { defaultLedgerPath, readLedgerRows } from '../lib/writer.js';

interface ReportOptions {
  chainId: string;
  repoRoot: string;
  ledgerPath?: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage: ao-ledger report --chain <id> [--repo-root <path>] [--ledger <path>] [--json]',
  ].join('\n');
}

export function parseLedgerArgs(argv: string[]): ReportOptions {
  let chainId: string | undefined;
  let repoRoot = process.cwd();
  let ledgerPath: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'report') {
      continue;
    }
    if (arg === '--chain') {
      chainId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--repo-root') {
      repoRoot = argv[i + 1] ?? repoRoot;
      i += 1;
      continue;
    }
    if (arg === '--ledger') {
      ledgerPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
    }
  }

  if (!chainId?.trim()) {
    throw new Error(`--chain is required\n${usage()}`);
  }

  return {
    chainId: chainId.trim(),
    repoRoot,
    ledgerPath,
    json,
  };
}

export function runLedgerReport(options: ReportOptions): number {
  const resolvedLedger =
    options.ledgerPath ?? defaultLedgerPath(options.repoRoot);
  const rows = readLedgerRows(resolvedLedger);
  const report = aggregateChain(rows, options.chainId);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatChainReport(report)}\n`);
  }
  return 0;
}

function isDirectExecution(): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryScript)
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'report') {
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }
  try {
    const options = parseLedgerArgs(['report', ...rest]);
    process.exit(runLedgerReport(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ao-ledger: ${message}\n`);
    process.exit(1);
  }
}
