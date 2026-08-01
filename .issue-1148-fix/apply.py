from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


page_test = Path("scripts/chatgpt-browser-turn/state-light-page-observation.test.ts")
text = page_test.read_text(encoding="utf-8")

text = replace_once(
    text,
    "async function runIdentityRuntimeTurn(\n  page: any,\n  prompt = 'PROMPT',\n): Promise<{ code: number; result: any; output?: string }> {",
    "async function runIdentityRuntimeTurn(\n  page: any,\n  prompt = 'PROMPT',\n  timeoutMs = '1000',\n): Promise<{ code: number; result: any; output?: string }> {",
    "runtime helper signature",
)

helper_start = text.index("async function runIdentityRuntimeTurn(")
helper_end = text.index("\ndescribe('Issue #1148 runtime identity binding'", helper_start)
helper = text[helper_start:helper_end]
helper = replace_once(
    helper,
    "      '--timeout-ms', '1000',",
    "      '--timeout-ms', timeoutMs,",
    "runtime helper timeout",
)
text = text[:helper_start] + helper + text[helper_end:]

text = replace_once(
    text,
    "    const outcome = await runIdentityRuntimeTurn(fake.page);\n\n    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });\n    expect(outcome.result.incidents).toContain('send_observation_deferred');",
    "    const outcome = await runIdentityRuntimeTurn(fake.page, 'PROMPT', '5000');\n\n    expect(outcome.result).toMatchObject({ state: 'ok', send_count: 1 });\n    expect(outcome.result.incidents).toContain('send_observation_deferred');",
    "deferred identity runtime budget",
)

isolation_start = text.index("  it('isolates byte-identical prompts in distinct owned tabs by opaque identity'")
isolation_end = text.index("\n  });\n});", isolation_start) + len("\n  });")
isolation = text[isolation_start:isolation_end]
isolation = replace_once(
    isolation,
    "      '--timeout-ms', '1000',",
    "      '--timeout-ms', '5000',",
    "concurrent identity runtime budget",
)
text = text[:isolation_start] + isolation + text[isolation_end:]
page_test.write_text(text, encoding="utf-8")

support = Path("scripts/chatgpt-browser-turn/state-light-turn.test-support.ts")
text = support.read_text(encoding="utf-8")
old_result = """    expect(outcome.result).toMatchObject({
      state: 'observation_uncertain',
      cause: 'owned_prompt_not_observed',
    });"""
new_result = """    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_unresolved',
    });"""
count = text.count(old_result)
if count != 2:
    raise SystemExit(f"fallback result assertions: expected two matches, found {count}")
text = text.replace(old_result, new_result)

text = replace_once(
    text,
    "  it('does not classify a transient duplicate owned user render as foreign activity', async () => {",
    "  it('fails closed when strict-text fallback observes duplicate owned candidates', async () => {",
    "duplicate fallback test name",
)

duplicate_start = text.index("  it('fails closed when strict-text fallback observes duplicate owned candidates'")
duplicate_end = text.index("\n  it('never emits send_failed once send_count is at least one'", duplicate_start)
duplicate = text[duplicate_start:duplicate_end]
duplicate = replace_once(
    duplicate,
    """    expect(outcome.code).toBe(0);
    expect(outcome.result).toMatchObject({
      state: 'ok',
      send_count: 1,
    });
    expect(outcome.result.state).not.toBe('observation_uncertain');""",
    """    expect(outcome.code).toBe(10);
    expect(outcome.result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'owned_message_identity_unresolved',
      send_count: 1,
    });
    expect(mocks.linkSync).not.toHaveBeenCalled();""",
    "duplicate fallback assertions",
)
text = text[:duplicate_start] + duplicate + text[duplicate_end:]
support.write_text(text, encoding="utf-8")

declaration = Path("docs/declarations/1148.issue-1148-message-identity.json")
data = json.loads(declaration.read_text(encoding="utf-8"))
added = "scripts/chatgpt-browser-turn/state-light-turn.test-support.ts"
if data.get("amendments") or added in data.get("declared_paths", []):
    raise SystemExit("declaration amendment precondition failed")
data["declared_paths"].append(added)
data["declared_paths"].sort()
data["amendments"] = [
    {
        "previous_active_scope_hash": "sha256:909c96107a308829b673a532c1cd1ca3eaf418e82a075ac6e431179f37fe3a94",
        "new_active_scope_hash": "sha256:e55b0111efd143a8c5ebf722490b32caa0d0e7aa61d02b309504395a36c37b5a",
        "changed": {"added": [added], "removed": []},
        "reason": "Update existing Browser-GPT regressions to the Issue #1148 fail-closed fallback contract revealed by current-head CI.",
        "actor": "chat-executor",
        "timestamp": "2026-08-01T06:35:00.000Z",
        "applied": True,
    }
]
declaration.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

print(
    json.dumps(
        {
            "page_test_sha256": hashlib.sha256(page_test.read_bytes()).hexdigest(),
            "support_sha256": hashlib.sha256(support.read_bytes()).hexdigest(),
            "declaration_sha256": hashlib.sha256(declaration.read_bytes()).hexdigest(),
        },
        sort_keys=True,
    )
)
