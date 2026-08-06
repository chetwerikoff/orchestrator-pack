_replace_once_before_review_fixture_bulk = replace_once


def replace_once(path: str, old: str, new: str) -> None:
    if path == 'scripts/toolchain/chatgpt-browser-turn.review-fixes.test.ts':
        p = Path(path)
        text = p.read_text()
        count = text.count(old)
        if count == 3:
            p.write_text(text.replace(old, new))
            return
    _replace_once_before_review_fixture_bulk(path, old, new)
