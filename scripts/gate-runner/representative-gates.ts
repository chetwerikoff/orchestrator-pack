import type { DeclarativeGateDefinition } from './declarative.ts';

const RETIRED_AGENT_RULES_FILE = `${['agent', 'rules'].join('_')}.md`;
const RETIRED_AGENT_RULES_PATTERN = RETIRED_AGENT_RULES_FILE.replace('.', '\\.');

export const agentRulesGrepGate: DeclarativeGateDefinition = {
  gateId: 'agent-rules-live-reference',
  legacyScript: 'scripts/check-agent-rules-grep-inventory.ps1',
  summary: `No live normative references to retired ${RETIRED_AGENT_RULES_FILE} remain.`,
  rules: [{
    kind: 'grep-inventory',
    patterns: [
      new RegExp(`prompts/${RETIRED_AGENT_RULES_PATTERN}`, 'u'),
      new RegExp(`prompts\\\\${RETIRED_AGENT_RULES_PATTERN}`, 'u'),
      new RegExp(`(?<![\\w/\\\\])${RETIRED_AGENT_RULES_PATTERN}`, 'u'),
    ],
    excludePrefixes: [
      'docs/declarations/',
      'docs/issues_drafts/',
      '.orchestrator-pack/',
      '.git/',
      'node_modules/',
      'trusted-scope-guard/',
      'tests/fixtures/',
      'scripts/gate-runner/goldens/',
    ],
    excludePaths: [
      'scripts/gate-runner/representative-gates.ts',
      'scripts/gate-runner/fixtures/declarative-fixtures.json',
      'tests/agents-md-relocation.test.ts',
      'scripts/gate-runner/goldens.test.ts',
      'scripts/gate-runner/declarative.test.ts',
      // Generated global Cursor hint; its text is superseded by pack policy and is not a pack-owned worker rulebook.
      '.cursor/rules/github-rest-over-graphql.mdc',
    ],
    failureSuffix: `references retired ${RETIRED_AGENT_RULES_FILE}`,
  }],
  passStdout: `[PASS] no live normative references to ${RETIRED_AGENT_RULES_FILE}\n`,
  failHeading: `[FAIL] live references to retired ${RETIRED_AGENT_RULES_FILE}:`,
};

export const agentRulesBudgetGate: DeclarativeGateDefinition = {
  gateId: 'agent-rules-size-budget',
  legacyScript: 'scripts/check-agent-rules-line-budget.ps1',
  summary: 'AGENTS.md stays within the worker-rule delivery budget.',
  rules: [{ kind: 'line-byte-budget', path: 'AGENTS.md', maxLines: 450, maxBytes: 28_672 }],
  passStdout: '',
  failHeading: '[FAIL] AGENTS.md size budget:',
};

export const agentRulesMovedContentGate: DeclarativeGateDefinition = {
  gateId: 'agent-rules-moved-content',
  legacyScript: 'scripts/check-agent-rules-moved-content.ps1',
  summary: 'Moved worker-rule content remains in its intended files.',
  rules: [
    {
      kind: 'file-presence',
      paths: [
        'AGENTS.md',
        'CLAUDE.md',
        'docs/coworker-delegation.md',
        'docs/tiering.md',
        'docs/script-owned-review-pipeline.md',
        'docs/orchestration-runbook.md',
        'docs/repository_policy.md',
        '.claude/skills/investigate-root-cause/SKILL.md',
        '.claude/skills/direct-fix-checklist/SKILL.md',
        '.claude/skills/discuss-with-gpt/SKILL.md',
        '.cursor/rules/draft-author-relocation.mdc',
        '.cursor/rules/flow-manager-browser-turn-monitoring.mdc',
      ],
    },
    {
      kind: 'static-source',
      assertions: [
        {
          path: 'AGENTS.md',
          absentFailurePrefix: 'AGENTS.md still contains moved deep-dive anchor',
          absent: [
            '## Task complexity tier rubric',
            '## Per-tier draft-review flow',
            '**Worked example.**',
            'git diff <base-ref>...HEAD > /tmp/review.diff',
            '## Script-owned review pipeline (documentation)',
            '## RCA spec discipline',
          ],
          contains: ['## Coworker CLI delegation', '## RTK read-exploration'],
          exactOccurrences: [
            { marker: '(docs/orchestration-runbook.md#worker-lifecycle)', count: 1 },
            { marker: '(docs/repository_policy.md#task-and-scope-authority)', count: 1 },
            { marker: '(docs/repository_policy.md#local-verification)', count: 1 },
            { marker: '(.claude/skills/investigate-root-cause/SKILL.md#failure-response)', count: 1 },
          ],
        },
        {
          path: 'CLAUDE.md',
          exactOccurrences: [
            { marker: '(.claude/skills/direct-fix-checklist/SKILL.md#architect-role-contract)', count: 1 },
            { marker: '(.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation)', count: 1 },
            { marker: '(.claude/skills/investigate-root-cause/SKILL.md#failure-response)', count: 1 },
          ],
        },
        {
          path: '.cursor/rules/draft-author-relocation.mdc',
          exactOccurrences: [
            { marker: '(../../.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation)', count: 1 },
          ],
        },
        {
          path: '.cursor/rules/flow-manager-browser-turn-monitoring.mdc',
          absent: ['## Stage and retry boundary', '## Publication and tab lifecycle', '## Session handoff'],
          exactOccurrences: [
            { marker: '## Launch and observation', count: 1 },
            { marker: '## Legacy state and diagnostic probe', count: 1 },
          ],
        },
        {
          path: 'docs/coworker-delegation.md',
          contains: ['PR diff recipe', 'git diff <base-ref>...HEAD > /tmp/review.diff', 'Root-cause work must read ~900 lines'],
        },
        {
          path: 'docs/tiering.md',
          contains: [
            '## Task complexity tier rubric',
            '### Failure-type lens (apply first)',
            '## Per-tier draft-review flow',
            '### Per-tier pipeline (ceilings, not quotas)',
          ],
        },
        {
          path: 'docs/script-owned-review-pipeline.md',
          contains: [
            '## Event-driven review trigger',
            '## Orchestrator review-run coverage',
            '## Head ready for review',
            'event-driven review trigger',
          ],
        },
      ],
    },
    {
      kind: 'section-anchor',
      roots: ['AGENTS.md', 'CLAUDE.md', '.cursor/rules'],
    },
  ],
  passStdout: '[PASS] AGENTS.md moved-content guard (split layout and stable titles)\n',
  failHeading: '[FAIL] AGENTS.md moved-content guard:',
};

export const representativeDeclarativeGates = [
  agentRulesGrepGate,
  agentRulesBudgetGate,
  agentRulesMovedContentGate,
] as const;
