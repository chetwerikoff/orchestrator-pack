import { evaluateDeclarativeGate, type DeclarativeGateDefinition } from './declarative.ts';
import type { GateRegistration } from './registry.ts';

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
  'plugins/ao-task-declaration/README.md',
  'plugins/ao-scope-guard/README.md',
  'plugins/ao-token-chain-ledger/README.md',
  'plugins/ao-codex-pr-reviewer/README.md',
  'scripts/bootstrap.ps1',
  'scripts/verify.ps1',
  'scripts/check-reusable.ps1',
  'scripts/install-git-hooks.ps1',
  'scripts/lint-self-architect.ps1',
  'scripts/lint-self-architect.config.json',
  'agent-orchestrator.yaml.example',
  '.github/workflows/scope-guard.yml',
] as const;

export const bulkDeclarativeGateDefinitions: readonly DeclarativeGateDefinition[] = [
  {
    gateId: 'verify-required-files',
    legacyScript: 'scripts/verify.ps1',
    summary: 'Pack required-file inventory',
    rules: [{ kind: 'file-presence', paths: VERIFY_REQUIRED_FILES }],
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
