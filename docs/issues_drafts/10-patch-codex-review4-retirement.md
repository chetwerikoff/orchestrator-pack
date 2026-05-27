# patch-codex-review4.ps1 retirement gate

## Prerequisite

None. This is a compatibility cleanup for the existing Windows AO 0.9.2 local
Codex review patch script.

## Goal

Make `scripts/patch-codex-review4.ps1` safely temporary: idempotent for affected
AO versions and a clear no-op once upstream AO contains the fix.

## Binding surface

PowerShell script behavior plus README documentation. No AO core changes.

## Files in scope

- `scripts/patch-codex-review4.ps1` — detect AO version and no-op for fixed versions
- `README.md` — document affected version, verification, and removal condition
- `docs/issues_drafts/10-patch-codex-review4-retirement.md` — this spec

## Files out of scope

- CI meta-checks around the temporary script
- AO core or vendored source changes
- New review functionality

## Acceptance criteria

- Script detects the installed AO version when possible.
- For affected versions (currently AO 0.9.2), script applies the patch
  idempotently.
- For fixed upstream versions (for example AO >= 0.9.3 once confirmed), script
  exits 0 with a clear no-op message.
- README documents:
  - why the script exists;
  - affected version;
  - how to verify whether it is still needed;
  - removal condition after upstream fix ships and is verified.

## Upgrade-safety check

- No local AO core changes are committed to this repository.
- Script remains safe to run after `npm install -g @aoagents/ao`.

## Verification

- Running the script twice on an affected AO version is idempotent.
- Running the script on a fixed version exits 0 and reports no-op.
- `./scripts/verify.ps1` still passes.
