import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';

export type ArchitectReviewKind = 'issue-draft' | 'adoption-proposal' | 'rca-memo';

const CODEX_ENV_STRIP = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CODEX_AUTH_JSON',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
] as const;

function repoRoot(): string {
  return resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
}

function parseArgs(argv: string[]): { artifactPath: string; kind: ArchitectReviewKind; failOnFindings: boolean } {
  let artifactPath = '';
  let kind: ArchitectReviewKind = 'issue-draft';
  let failOnFindings = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--artifact-path':
      case '-ArtifactPath':
        artifactPath = argv[++index] ?? '';
        break;
      case '--kind':
      case '-Kind':
        kind = (argv[++index] ?? kind) as ArchitectReviewKind;
        break;
      case '--fail-on-findings':
      case '-FailOnFindings':
        failOnFindings = true;
        break;
      default:
        if (!artifactPath && !arg.startsWith('-')) artifactPath = arg;
        break;
    }
  }
  if (!artifactPath) throw new Error('ArtifactPath is required');
  if (!['issue-draft', 'adoption-proposal', 'rca-memo'].includes(kind)) {
    throw new Error(`unsupported kind: ${kind}`);
  }
  return { artifactPath, kind, failOnFindings };
}

function buildPrompt(kind: ArchitectReviewKind, resolved: string, text: string, root: string): string {
  const draftReviewPromptPath = join(root, 'prompts/codex_draft_review_prompt.md');
  switch (kind) {
    case 'issue-draft': {
      if (!existsSync(draftReviewPromptPath)) {
        throw new Error(`Missing draft review prompt: ${draftReviewPromptPath}`);
      }
      return readFileSync(draftReviewPromptPath, 'utf8').replace(
        '{{ARTIFACT_SECTION}}',
        `--- ARTIFACT (${resolved}) ---\n${text}`,
      );
    }
    case 'adoption-proposal':
      return [
        'You are a critical reviewer for orchestrator-pack adoption proposals (read-only).',
        'Critique the ADOPTION DECISIONS below — do not summarize the external source.',
        'Check: cargo-cult risk, planner-freedom if we spec work, upgrade-safety (no core patch),',
        'command accuracy, and whether pain is real.',
        'Do NOT explore the repository unless the proposal is ambiguous.',
        '',
        'Tag valid issues P0, P1, or P2.',
        'If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.',
        '',
        `--- ARTIFACT (${resolved}) ---`,
        text,
      ].join('\n');
    case 'rca-memo':
      return [
        'You are a critical reviewer for a root-cause investigation memo (read-only).',
        'Challenge unsupported claims, missing queue/architecture search, items listed under Planned',
        'that are closed, merged, or already on main, and patches proposed as durable fixes.',
        '',
        'Tag valid issues P0, P1, or P2.',
        'If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.',
        '',
        `--- ARTIFACT (${resolved}) ---`,
        text,
      ].join('\n');
    default:
      throw new Error(`unsupported kind: ${kind satisfies never}`);
  }
}

export function runArchitectArtifactReview(options: {
  artifactPath: string;
  kind?: ArchitectReviewKind;
  failOnFindings?: boolean;
  root?: string;
}): number {
  const root = options.root ?? repoRoot();
  const resolved = resolve(options.artifactPath);
  if (!existsSync(resolved)) {
    throw new Error(`Artifact not found: ${options.artifactPath}`);
  }
  const text = readFileSync(resolved, 'utf8');
  const kind = options.kind ?? 'issue-draft';
  const prompt = buildPrompt(kind, resolved, text, root);

  process.stdout.write(`== architect codex review (${kind}) ==\n`);
  process.stdout.write(`Artifact: ${resolved}\n`);
  process.stdout.write('Invoker: codex review (NOT codex exec / codex exec review)\n');
  process.stdout.write('Sandbox: sandbox_mode=danger-full-access (no containment)\n');

  const savedEnv: Record<string, string | undefined> = {};
  for (const name of CODEX_ENV_STRIP) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }

  let output = '';
  try {
    const result = runProcessSync({
      command: 'codex',
      args: ['review', '-c', 'sandbox_mode=danger-full-access', prompt],
      inheritParentEnv: true,
    });
    output = `${result.stdout}${result.stderr}`.trimEnd();
    if (output) process.stdout.write(`${output}\n`);
    if (result.outcome === 'spawn-failure') throw new Error(result.error ?? 'codex review spawn failed');
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const clean = /(?m)^NO_FINDINGS\s*$/u.test(output);
  if (options.failOnFindings && !clean) return 1;
  return 0;
}

function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);
    return runArchitectArtifactReview(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
