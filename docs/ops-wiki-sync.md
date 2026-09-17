# Operational wiki sync

Export governed `orchestrator-pack` procedures from one exact Git commit into a
machine-local `wiki-ops` corpus. The repository remains the only versioned
authority. The corpus is disposable derived output and must not be a Git
repository.

## Placeholders

Operator-local values stay untracked. Substitute them at adoption time:

```text
PACK_OPS_WIKI_CORPUS_ROOT=<absolute-corpus-root>
PACK_OPS_WIKI_MCP_URL=<wiki-ops-mcp-url>
PACK_SYNTO_VAULT=<absolute-synto-vault-if-present>
PACK_OPS_WIKI_CONVERGENCE_TIMEOUT_MS=<milliseconds>
```

Do not commit those values, ports, service unit names, or credentials.

## Commands

Repository-mode drift check (no corpus, MCP, or embeddings):

```bash
node --experimental-strip-types scripts/sync-ops-wiki.ts check --commit <40-hex-or-ref>
```

Plan the same extraction:

```bash
node --experimental-strip-types scripts/sync-ops-wiki.ts plan --commit <40-hex-or-ref>
```

Apply to the corpus. Pass the actual post-adoption checkout `HEAD` once, never a
moving `main` name and never the PR merge SHA unless it equals that HEAD:

```bash
COMMIT=$(git rev-parse HEAD)
node --experimental-strip-types scripts/sync-ops-wiki.ts apply \
  --commit "$COMMIT" \
  --corpus-root "$PACK_OPS_WIKI_CORPUS_ROOT"
```

Bootstrap or repair with an explicit one-shot reindex request to the existing
search implementation:

```bash
node --experimental-strip-types scripts/sync-ops-wiki.ts apply \
  --commit "$COMMIT" \
  --corpus-root "$PACK_OPS_WIKI_CORPUS_ROOT" \
  --reindex incremental
```

`--reindex full` forces a full rebuild through the same existing search tool.
This is diagnostic recovery only, not the normal post-adoption path.

## Status and trust

The owned status note `Ops Wiki Status.md` records:

- `checked_through_commit` — the last commit whose changed and removed episodes
  plus golden retrieval passed index-served read-back
- `apply_in_progress` — the target commit while mutation or read-back is unfinished

Agents may rely on `wiki-ops` only when index-served `wiki-ops.read` of that
status note returns the exact current/adopted commit and no `apply_in_progress`.
Any mismatch, in-progress state, absence, malformed content, unsupported
read-back, or timeout means: read the current canonical repository file.

## Failure and rollback

A degraded apply does not undo repository adoption and does not block unrelated
work. It never claims the new revision searchable.

- Failure before episode mutation: prior clean status remains.
- Failure after `apply_in_progress` is published: that fence stays until an
  explicit successful rerun. Do not invent rollback journals.

If the corpus is mixed, rerun `apply` for the same target commit. To restore
previous generated text, check out the previous repository revision and rerun
apply for that commit. Foreign files, vault-root dotfiles, and the search
database remain untouched.

## Agent routing

See `AGENTS.md` section Operational wiki consultation. Search results are
navigation aids. Verify the current canonical repository file before any
decision or effect.
