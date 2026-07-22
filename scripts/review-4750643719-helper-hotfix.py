from __future__ import annotations

import sys
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one helper block, found {count}')
    return source.replace(old, new, 1)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit('usage: helper-hotfix.py APPLY_PY')
    path = Path(sys.argv[1])
    source = path.read_text(encoding='utf-8')

    source = replace_once(
        source,
        '''replace_once(
    'scripts/pr2-foundation/worker-notification.ts',
    """      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
""",
    """      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
      reviewRunId: input.reviewRunId,
""",
    'notification persisted reviewRunId',
)
''',
        '''replace_once(
    'scripts/pr2-foundation/worker-notification.ts',
    """      adoptionProbeRunIdHash: '',
      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
    };
""",
    """      adoptionProbeRunIdHash: '',
      deterministicKey: input.deliveryKey,
      findingsHash: input.findingsHash,
      reviewRunId: input.reviewRunId,
    };
""",
    'notification persisted reviewRunId',
)
''',
        'notification record anchor',
    )

    source = replace_once(
        source,
        '''insert_before_once(
    'scripts/pr2-foundation/mutation-semantic-gates.test.ts',
    """});
""",
    """
  it('builds a bounded non-empty mutation plan for every declared control', () => {
    for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
      for (const mutationId of ids) {
        const key = `${ac}:${mutationId}`;
        const bindingPath = (await import('./mutation-catalog.ts')).FOUNDATION_MUTATION_CATALOG
          .find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
        expect(bindingPath, key).toBeTruthy();
        const absolute = path.resolve(bindingPath!);
        const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
        const plan = buildBoundedSemanticMutation(key, source);
        expect(plan.artifactPath, key).toBe(bindingPath);
        expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
        expect(plan.content, key).not.toBe(source);
      }
    }
  });
""",
    'semantic test bounded plans',
)
# The inserted test uses await; make the callback async and import catalog statically instead.
semantic_test = read('scripts/pr2-foundation/mutation-semantic-gates.test.ts')
semantic_test = semantic_test.replace(
    "import { AC_MUTATION_CONTROLS } from './contracts.ts';\n",
    "import { AC_MUTATION_CONTROLS } from './contracts.ts';\nimport { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';\n",
)
semantic_test = semantic_test.replace(
    "const bindingPath = (await import('./mutation-catalog.ts')).FOUNDATION_MUTATION_CATALOG\n          .find",
    "const bindingPath = FOUNDATION_MUTATION_CATALOG\n          .find",
)
write('scripts/pr2-foundation/mutation-semantic-gates.test.ts', semantic_test)
''',
        '''semantic_test = read('scripts/pr2-foundation/mutation-semantic-gates.test.ts')
semantic_test = semantic_test.replace(
    "import { AC_MUTATION_CONTROLS } from './contracts.ts';\n",
    "import { AC_MUTATION_CONTROLS } from './contracts.ts';\nimport { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';\n",
)
semantic_marker = "\n});\n"
semantic_index = semantic_test.rfind(semantic_marker)
if semantic_index < 0:
    raise SystemExit('semantic test final describe marker missing')
semantic_insertion = """
  it('builds a bounded non-empty mutation plan for every declared control', () => {
    for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
      for (const mutationId of ids) {
        const key = `${ac}:${mutationId}`;
        const bindingPath = FOUNDATION_MUTATION_CATALOG
          .find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
        expect(bindingPath, key).toBeTruthy();
        const absolute = path.resolve(bindingPath!);
        const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
        const plan = buildBoundedSemanticMutation(key, source);
        expect(plan.artifactPath, key).toBe(bindingPath);
        expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
        expect(plan.content, key).not.toBe(source);
      }
    }
  });
"""
semantic_test = semantic_test[:semantic_index] + semantic_insertion + semantic_test[semantic_index:]
write('scripts/pr2-foundation/mutation-semantic-gates.test.ts', semantic_test)
''',
        'semantic test final insertion',
    )

    path.write_text(source, encoding='utf-8')


if __name__ == '__main__':
    main()
