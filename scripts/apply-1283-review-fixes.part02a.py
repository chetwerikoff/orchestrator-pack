_replace_once_strict_before_review_fixtures = replace_once


def replace_once(path: str, old: str, new: str) -> None:
    special_path = 'scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts'
    special_old = "      cleanupAuthorityPage: lostPage,\n    };\n\n    const result = await runPostSendRecovery({"
    if path == special_path and old == special_old:
        p = Path(path)
        text = p.read_text()
        count = text.count(old)
        if count != 3:
            raise SystemExit(
                f"{path}: expected three recovery-state anchors, got {count}: {old[:100]!r}"
            )
        p.write_text(text.replace(old, new))
        return
    _replace_once_strict_before_review_fixtures(path, old, new)
