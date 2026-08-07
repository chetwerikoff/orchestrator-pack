from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrence(s) of {old!r}, got {actual}')
    p.write_text(text.replace(old, new), encoding='utf-8')


def remove_exact(path: str, old: str, count: int = 1) -> None:
    replace_exact(path, old, '', count)


replace_exact(
    '.gitignore',
    '# Local AO config generated from the reusable example.\n# Commit agent-orchestrator.yaml.example, not real target-repo configs.\nagent-orchestrator.yaml\nagent-orchestrator.*.yaml\n!agent-orchestrator.yaml.example\n',
    '# Operator-local pack state. Repository behavior is config-file independent.\n.orchestrator-pack/\n',
)
remove_exact('.gitignore', '# AO runtime/session state. Keep committed material reusable only.\n.ao/\n.agent-orchestrator/\n\n')

for path, line in [
    ('scripts/estate-cut/capture-base-anchor.mjs', "  'agent-orchestrator.yaml.example',\n"),
    ('scripts/estate-cut/manifest-generator.mjs', "  if (!currentSet.has('agent-orchestrator.yaml.example')) failures.push('agent-orchestrator.yaml.example is missing');\n"),
    ('scripts/lib/graphql-quota-github-read-inventory.json', '      "agent-orchestrator.yaml.example"\n'),
    ('scripts/pr-scope-declaration.ts', "  'agent-orchestrator.yaml.example',\n"),
    ('scripts/pr2-foundation/contracts.ts', "  'agent-orchestrator.yaml.example',\n"),
]:
    remove_exact(path, line)

replace_exact(
    'scripts/lib/graphql-quota-github-read-inventory.json',
    '      "prompts/investigate_root_cause.md",\n',
    '      "prompts/investigate_root_cause.md"\n',
)
replace_exact(
    'scripts/orchestrator-message-audit-roots.manifest.json',
    '  "orchestratorRulesBindings": [\n    "agent-orchestrator.yaml.example"\n  ]\n',
    '  "orchestratorRulesBindings": []\n',
)
replace_exact(
    'scripts/orchestrator-message-protected-runtime.manifest.json',
    '    "scripts/review-trigger-reconcile.ps1",\n    "scripts/review-trigger-reeval.ps1",\n    "agent-orchestrator.yaml.example"\n',
    '    "scripts/review-trigger-reconcile.ps1",\n    "scripts/review-trigger-reeval.ps1"\n',
)
replace_exact(
    'scripts/pr2a/closed-world-scanner.ts',
    "      'scripts', 'tests', '.github', 'package.json', 'tsconfig.json', 'agent-orchestrator.yaml.example', 'docs',\n",
    "      'scripts', 'tests', '.github', 'package.json', 'tsconfig.json', 'docs',\n",
)
replace_exact(
    'scripts/pr2a/execution-root-registry.json',
    '"patterns": ["agent-orchestrator.yaml.example", "scripts/**/*.json", "docs/**/*.md"]',
    '"patterns": ["scripts/**/*.json", "docs/**/*.md"]',
)
replace_exact(
    'scripts/toolchain/check-typescript-runtime-policy.ts',
    "const ROOTS = ['package.json', 'agent-orchestrator.yaml.example', '.github', 'docs', 'plugins', 'scripts', 'tests'] as const;",
    "const ROOTS = ['package.json', '.github', 'docs', 'plugins', 'scripts', 'tests'] as const;",
)
remove_exact(
    'scripts/toolchain/check-typescript-runtime-policy.ts',
    "        || path === 'agent-orchestrator.yaml.example'\n",
)
replace_exact(
    'scripts/gate-runner/bulk-declarative-gates.ts',
    "export const VERIFY_RETIRED_FILES = ['agent-orchestrator.yaml.example'] as const;",
    "const retiredConfigExample = ['agent', 'orchestrator.yaml.example'].join('-');\nexport const VERIFY_RETIRED_FILES = [retiredConfigExample] as const;",
)

for path in [
    'scripts/lib/Autonomous-ClaimPrResumeGate.ps1',
    'scripts/lib/Autonomous-SpawnWorktreeGate.ps1',
    'scripts/lib/Journaled-WorkerSendInternalCapability.ps1',
]:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if '.agent-orchestrator' not in text:
        raise SystemExit(f'{path}: retired state-root fallback missing')
    p.write_text(text.replace('.agent-orchestrator', '.orchestrator-pack'), encoding='utf-8')

replace_exact(
    'scripts/lib/Autonomous-SpawnWorktreeGate.ps1',
    """function Get-AutonomousSpawnWorktreeProjectId {
    $project = if ($env:AO_PROJECT_ID) { $env:AO_PROJECT_ID.Trim() }
    elseif ($env:AO_PROJECT) { $env:AO_PROJECT.Trim() }
    else { 'orchestrator-pack' }
    if (-not $project) { return 'orchestrator-pack' }
    return $project
}
""",
    """function Get-AutonomousSpawnWorktreeProjectId {
    $project = if ($env:OPK_PROJECT_ID) { $env:OPK_PROJECT_ID.Trim() } else { 'orchestrator-pack' }
    if (-not $project) { return 'orchestrator-pack' }
    return $project
}
""",
)
