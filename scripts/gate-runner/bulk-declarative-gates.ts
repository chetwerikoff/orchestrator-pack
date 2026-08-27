import { evaluateDeclarativeGate, type DeclarativeGateDefinition } from './declarative.ts';
import type { GateRegistration } from './registry.ts';

const retiredConfigExample = ['agent', 'orchestrator.yaml.example'].join('-');
export const VERIFY_RETIRED_FILES = [retiredConfigExample] as const;

export const VERIFY_REQUIRED_FILES = [
  'README.md',
  '.gitignore',
  '.gitattributes',
  'docs/migration_notes.md',
  'docs/architecture.md',
  'docs/github_issues_cursor_codex_setup.md',
  'docs/repository_policy.md',
  'prompts/self_architect_check.md',
  'AGENTS.md',
  'plugins/README.md',
  'plugins/task-declaration/README.md',
  'plugins/scope-guard/README.md',
  'plugins/token-chain-ledger/README.md',
  'plugins/codex-pr-reviewer/README.md',
  'scripts/bootstrap.ts',
  'scripts/verify.ps1',
  'scripts/check-reusable.ps1',
  'scripts/install-git-hooks.ps1',
  'scripts/lint-self-architect.ps1',
  'scripts/lint-self-architect.config.json',
  '.github/workflows/scope-guard.yml',
] as const;

export const bulkDeclarativeGateDefinitions: readonly DeclarativeGateDefinition[] = [
  {
    gateId: 'verify-required-files',
    legacyScript: 'scripts/verify.ps1',
    summary: 'Pack required-file inventory',
    rules: [
      { kind: 'file-presence', paths: VERIFY_REQUIRED_FILES },
      { kind: 'file-absence', paths: VERIFY_RETIRED_FILES },
    ],
    passStdout: '[PASS] verify required-file inventory\n',
    failHeading: 'Missing required pack files:',
  },
] as const;

export const bulkDeclarativeGateRegistrations: readonly GateRegistration[] = bulkDeclarativeGateDefinitions.map(
  (definition): GateRegistration => ({
    gateId: definition.gateId,
    evaluate: ({ snapshot }) => evaluateDeclarativeGate(definition, snapshot),
  }),
);
