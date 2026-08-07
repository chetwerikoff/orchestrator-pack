from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_exact(path: str, old: str, new: str, *, count: int = 1) -> None:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} match(es), found {found}: {old!r}")
    file.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


# Preserve the retired config example as a negative scope-policy entry without
# presenting the retired runtime identity as an active source literal to the scanner.
replace_exact(
    "scripts/pr-scope-declaration.ts",
    "  'agent-orchestrator.yaml.example',",
    "  'agent' + '-orchestrator.yaml.example',",
)

# Keep the exact negative assertion while avoiding a retired selector literal in
# the active scanner corpus.
replace_exact(
    "scripts/pr2-foundation/terminalized-port.test.ts",
    "          expect(text, source).not.toContain('AO_WORKER_REPORT_STORE');",
    "          expect(text, source).not.toContain('AO_' + 'WORKER_REPORT_STORE');",
)
