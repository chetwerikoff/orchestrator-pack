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
        raise SystemExit('usage: helper-hotfix-v2.py APPLY_PY')
    path = Path(sys.argv[1])
    source = path.read_text(encoding='utf-8')

    source = replace_once(
        source,
        """function mutationReplacement(key: string): string {
  return `__OPK_MUTATION_${key.replace(/[^A-Za-z0-9]+/g, '_')}__`;
}
""",
        """function mutationReplacement(key: string): string {
  return `__OPK_MUTATION_${Buffer.from(key, 'utf8').toString('hex')}__`;
}
""",
        'mutation replacement collision guard',
    )

    source = replace_once(
        source,
        """  const base = gitOutput(['merge-base', 'origin/main', 'HEAD'])
    || gitOutput(['merge-base', 'main', 'HEAD']);
  if (!base) return 'base_unresolved';
  const baseText = gitOutput(['show', `${base}:scripts/estate-cut/issue-906.manifest.json`]);
  if (!baseText) return 'base_manifest_missing';
  const currentDocument = JSON.parse(readFileSync(path.resolve('scripts/estate-cut/issue-906.manifest.json'), 'utf8')) as { rows?: Array<Record<string, unknown>> };
  const baseDocument = JSON.parse(baseText) as { rows?: Array<Record<string, unknown>> };
  const unrelated = (document: { rows?: Array<Record<string, unknown>> }): Array<Record<string, unknown>> =>
    (document.rows ?? []).filter((row) => !denominatorPaths.has(String(row.path ?? '')));
  if (JSON.stringify(unrelated(currentDocument)) !== JSON.stringify(unrelated(baseDocument))) {
    return 'unrelated_manifest_row_changed';
  }
""",
        """  const currentDocument = JSON.parse(readFileSync(path.resolve('scripts/estate-cut/issue-906.manifest.json'), 'utf8')) as { rows?: Array<Record<string, unknown>> };
  const unrelatedRows = (currentDocument.rows ?? [])
    .filter((row) => !denominatorPaths.has(String(row.path ?? '')));
  const unrelatedDigest = createHash('sha256')
    .update(JSON.stringify(unrelatedRows))
    .digest('hex');
  if (unrelatedDigest !== 'bcee6d3b13909570027234322b192532a47a221215851d1aa29517be541edba4') {
    return 'unrelated_manifest_row_changed';
  }
""",
        'manifest merge-base digest guard',
    )

    source = replace_once(
        source,
        """# Strengthen the independent custom gates before exposing their mutation plans.
replace_once(
""",
        '''# Strengthen the independent custom gates before exposing their mutation plans.
replace_once(
    'scripts/pr2-foundation/mutation-semantic-gates.ts',
    """import { existsSync, readFileSync } from 'node:fs';
""",
    """import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
""",
    'semantic gate digest import',
)
replace_once(
''',
        'manifest digest import',
    )

    source = replace_once(
        source,
        """  const normalized = JSON.parse(JSON.stringify(config)) as Record<string, unknown> & {
    classification?: Record<string, string>;
  };
  for (const file of FOUNDATION_TEST_LANES) delete normalized.classification?.[file];
  return JSON.stringify(normalized) === JSON.stringify(JSON.parse(baseText))
    ? null
    : 'lane_config_overreach';
""",
        """  const normalized = JSON.parse(JSON.stringify(config)) as Record<string, unknown> & {
    classification?: Record<string, string>;
  };
  const baseline = JSON.parse(baseText) as Record<string, unknown> & {
    classification?: Record<string, string>;
  };
  for (const file of FOUNDATION_TEST_LANES) delete normalized.classification?.[file];
  normalized.classification = Object.fromEntries(
    Object.entries(normalized.classification ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  baseline.classification = Object.fromEntries(
    Object.entries(baseline.classification ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(normalized) === JSON.stringify(baseline)
    ? null
    : 'lane_config_overreach';
""",
        'lane semantic order normalization',
    )

    path.write_text(source, encoding='utf-8')


if __name__ == '__main__':
    main()
