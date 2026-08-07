from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_exact(path: str, old: str, new: str, *, count: int = 1) -> None:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} exact match(es), found {found}: {old[:140]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


# Mutation recipes operate on source bytes. The historical frozen command is
# intentionally escaped in source, so the recipe anchor must carry a literal
# backslash rather than evaluate the Unicode escape inside the recipe string.
replace_exact(
    "scripts/pr2-foundation/mutation-behavior-recipes.ts",
    "    anchor: \"if (input.command !== 'a\\u006f session ls --json') return { ok: false, reason: 'preflight_command_mismatch' };\",",
    "    anchor: \"if (input.command !== 'a\\\\u006f session ls --json') return { ok: false, reason: 'preflight_command_mismatch' };\",",
)

# #1352 removes one historical foundation row from the surviving independent
# union. Keep the mutation aimed at the actual survivingRows proof expression.
replace_exact(
    "scripts/pr2-foundation/mutation-behavior-recipes.ts",
    "    anchor: '  const changedPaths = rows.map((row) => row.path);',\n    replacement: \"  const changedPaths = [...rows.map((row) => row.path), 'README.md'];\",",
    "    anchor: '  const changedPaths = survivingRows.map((row) => row.path);',\n    replacement: \"  const changedPaths = [...survivingRows.map((row) => row.path), 'README.md'];\",",
)

# Two historical foundation rows now have active runtime-neutral owners. Keep
# the old banner assertion for the other rows, but assert concrete hard-cut
# properties for these two rather than weakening the test globally.
replace_exact(
    "scripts/pr2-foundation/terminalized-port.test.ts",
    "const runtimeNeutralFoundationSource = 'docs/review-bulk-send-diagnose.mjs';",
    "const runtimeNeutralFoundationSources = new Set([\n  'docs/review-bulk-send-diagnose.mjs',\n  'docs/worker-report-store.mjs',\n]);",
)
replace_exact(
    "scripts/pr2-foundation/terminalized-port.test.ts",
    "      if (source === runtimeNeutralFoundationSource) {\n        expect(text, source).toContain('The pack review producer/store is the only active authority.');\n        expect(text, source).not.toContain('ao-0-10-review-api');\n      } else {\n        expect(text, source).toMatch(/^\\/\\/ Issue #923 foundation-terminalized:/);\n      }",
    "      if (runtimeNeutralFoundationSources.has(source)) {\n        if (source === 'docs/review-bulk-send-diagnose.mjs') {\n          expect(text, source).toContain('The pack review producer/store is the only active authority.');\n          expect(text, source).not.toContain('ao-0-10-review-api');\n        } else {\n          expect(text, source).toContain('export const WORKER_REPORT_STORE_SCHEMA_VERSION = 3;');\n          expect(text, source).toContain('OPK_WORKER_REPORT_STORE');\n          expect(text, source).not.toContain('AO_WORKER_REPORT_STORE');\n        }\n      } else {\n        expect(text, source).toMatch(/^\\/\\/ Issue #923 foundation-terminalized:/);\n      }",
)
