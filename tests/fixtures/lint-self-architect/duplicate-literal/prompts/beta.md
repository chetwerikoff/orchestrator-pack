# Beta prompt fragment

Before implementing, staging, or committing, run this short check:

1. Paired script/template edits: am I changing the same behavior in both a script
   and a template? If yes, extract or generate from one source of truth.
2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple
   files? If yes, centralize it before continuing.
3. Broad declarations: is the declared scope a whole directory or glob when a
   file-level scope would work? If yes, narrow it or justify it explicitly.
4. New subsystem smell: am I adding a new subsystem for behavior that AO already
   has through config, reactions, session metadata, or plugin slots?
5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use
   plugin/config/prompt/wrapper/hook/CI instead.
