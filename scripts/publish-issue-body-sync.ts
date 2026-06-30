#!/usr/bin/env node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isDirectCliExecution,
  handleCliHelpOrJson,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerTsCli,
  throwUnknownCliArg,
} from './lib/reviewer-ts-cli.js';
import {
  readDraftFile,
  syncPublishIssueBody,
  type MutationAuditRecord,
  type PublishIssueBodySyncInput,
} from './lib/publish-issue-body-sync.js';

type Mode = 'create' | 'edit' | 'verify';

interface CliOptions {
  mode: Mode;
  draftPath: string;
  repo: string;
  issueNumber?: number;
  title?: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  publish-issue-body-sync.ts create --draft-path <path> --repo <owner/name> [--title <title>] [--json]',
    '  publish-issue-body-sync.ts edit --draft-path <path> --issue-number <n> --repo <owner/name> [--json]',
    '  publish-issue-body-sync.ts verify --draft-path <path> --issue-number <n> --repo <owner/name> [--json]',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const modeToken = argv[2];
  if (modeToken !== 'create' && modeToken !== 'edit' && modeToken !== 'verify') {
    throw new Error(`first argument must be create, edit, or verify\n${usage()}`);
  }

  const opts: CliOptions = {
    mode: modeToken,
    draftPath: '',
    repo: 'chetwerikoff/orchestrator-pack',
    json: false,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--draft-path':
        opts.draftPath = String(argv[++i] ?? '');
        break;
      case '--repo':
        opts.repo = String(argv[++i] ?? opts.repo);
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--title':
        opts.title = String(argv[++i] ?? '');
        break;
      default:
        if (!handleCliHelpOrJson(arg, usage(), () => {
          opts.json = true;
        })) {
          throwUnknownCliArg(arg, usage());
        }
        break;
    }
  }

  return opts;
}

function resolvePackGh(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, 'gh');
}

function runGh(argv: string[]) {
  const gh = resolvePackGh();
  const result = spawnSync(gh, argv.slice(1), { encoding: 'utf8' });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function buildInput(opts: CliOptions, draftContent: string): PublishIssueBodySyncInput {
  if (opts.mode === 'create') {
    return {
      mode: 'create',
      draftPath: opts.draftPath,
      draftContent,
      repo: opts.repo,
      title: opts.title,
    };
  }

  const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber ?? ''), '--issue-number');
  if (opts.mode === 'edit') {
    return {
      mode: 'edit',
      draftPath: opts.draftPath,
      draftContent,
      repo: opts.repo,
      issueNumber,
    };
  }

  return {
    mode: 'verify',
    draftPath: opts.draftPath,
    draftContent,
    repo: opts.repo,
    issueNumber,
  };
}

function main(): void {
  const opts = parseArgs(process.argv);
  const draftPath = parseRequiredNonEmptyString(opts.draftPath, '--draft-path');
  const draftContent = readDraftFile(draftPath);
  const input = buildInput(opts, draftContent);
  const auditRecords: MutationAuditRecord[] = [];

  const result = syncPublishIssueBody(
    {
      runGh,
      writeBodyFile(content: string) {
        const dir = mkdtempSync(join(tmpdir(), 'publish-issue-body-'));
        const filePath = join(dir, 'issue-body.md');
        writeFileSync(filePath, content, 'utf8');
        return filePath;
      },
      emitAudit(record) {
        auditRecords.push(record);
        const payload = JSON.stringify({ event: 'publish-issue-body-mutation-audit', ...record });
        console.error(payload);
      },
    },
    input,
  );

  if (opts.json) {
    console.log(JSON.stringify({ ...result, auditRecords }, null, 2));
  } else if (result.ok) {
    console.log(`publish-issue-body sync succeeded for issue #${result.issueNumber} (${opts.repo})`);
  } else {
    console.error(result.message);
  }

  process.exit(result.ok ? 0 : 1);
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
