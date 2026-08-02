# AO-free PR scope declarations

The AO-free declaration producer produces the only schema accepted by
`scripts/pr-scope-check.ps1`. It reads the linked Issue's `denylist` and
`allowed-roots` fences, writes one artifact under `docs/declarations/`, and
does not use AO state or session metadata.

```bash
npm run check:node-major --silent && node --experimental-strip-types scripts/pr-scope-declaration.ts --issue 1210 --declared-paths scripts/pr-scope-check.ts,scripts/pr-scope-declaration.ts --declared-prefixes 'scripts/pr-scope-tests/**'
```

The resulting `docs/declarations/<issue>.pr-scope.json` is canonical JSON:
repository-relative paths use `/`, `.` segments are collapsed, `..` cannot
escape the repository, arrays are sorted, and duplicates are rejected.
Directory prefixes are explicit terminal `/**` entries. The artifact may add
denials or narrow roots, but cannot weaken the repository policy.

The required check obtains the PR diff from the verified merge base and PR head:

```text
git diff --name-status --find-renames <merge_base_sha> <head_sha>
```

Adds, modifications, and deletions check their affected path. Copies check the
destination; renames check both endpoints. Exactly one valid current-Issue
artifact is selected. Every other current-Issue file, malformed artifact,
unsupported/AO-era schema, wrong-Issue candidate, ambiguous candidate, or
uncertain diff fails closed. The remediation is a fresh declaration and a new
PR; no legacy projection or fallback is attempted.
