# Synto knowledge-base pilot (one book)

Operator methodology for a **local, one-book** pilot of
[synto](https://github.com/kytmanov/synto) — MIT LLM-wiki tool with index-routed
retrieval and a built-in stdio MCP server. This doc is the only durable repo
surface; the vault and wiki stay on your machine.

**Operator guide (RU):** [`synto-knowledge-base-pilot.ru.md`](synto-knowledge-base-pilot.ru.md)

**Queue spec:** `docs/issues_drafts/96-synto-knowledge-base-pilot.md`

**Version band:** written for synto **0.6.x**; record `synto --version` in the result
section — minor/patch drift can change MCP tools and lifecycle behavior.

## What this is (and is not)

- **Is:** a numbered runbook for *you* (the operator) plus paste-ready prompts for
  a **vault agent** — a separate agent session you open **inside the vault
  folder**, not an AO worker and not inside `orchestrator-pack`.
- **Is not:** worker-flow integration, multi-book library management, or
  committed vault/wiki content. Follow-up work is gated on the go/no-go verdict
  below.

The go/no-go judges **synto index-routing usefulness on one book** — whether a
task-wording question routes to a relevant published article. It does **not** by
itself prove hybrid/BM25+embedding retrieval or multi-book scale.

## Local-only boundary (do not commit)

Keep all of the following **outside** the `orchestrator-pack` git worktree and
**out of git** in this repo:

| Artifact | Typical location | Why |
|----------|------------------|-----|
| Synto vault (wiki, drafts, SQLite) | e.g. `/home/you/synto-pilots/my-book-wiki/` | Synto auto-commits with a `[synto]` prefix — inside the pack worktree that would pollute this repo |
| Book file (PDF / export) | operator-chosen; copied into vault via `synto add` | Copyright + repo hygiene |
| `~/.config/synto/config.toml` | user home | Provider API keys |
| MCP client wiring | e.g. Cursor `mcp.json`, Claude settings | Local stdio launch of `synto serve` |

**Isolation:** synto stores state in SQLite. Use a **dedicated vault directory**
with its own `.synto/state.db` — do not point multiple agents or repos at one
shared DB (this pack has known SQLite write-lock contention on shared databases).

**Paths:** use **absolute** vault paths everywhere (shell, MCP JSON, prompts).
On WSL, run synto and the MCP client in the **same environment** (both WSL or
both Windows native) so they resolve the same `synto` binary and vault path.

## Vault agent safety

The vault agent runs in a folder that will soon contain LLM-generated articles.
A concept page could carry a stray instruction. Therefore:

- **Not an AO worker** — do not `ao spawn` synto steps from this pack.
- **Minimal tools** — file/shell access scoped to the vault directory only; no
  pack-repo git, no orchestrator YAML, no broad system admin.
- **No secrets in chat logs** — API keys belong in `~/.config/synto/config.toml`,
  not in pasted prompts or this doc's result section.

### Forbidden for the vault agent (any step)

Do **not** run these unless the operator explicitly overrides:

| Forbidden | Why |
|-----------|-----|
| `run --auto-approve` / bulk approve without review | Skips human quality gate |
| `watch` | Background mutations while you review or test MCP |
| `serve` with HTTP/streamable transport | Unauthenticated network exposure |
| `answer_question` (MCP) or `synto query --synthesize` | On-the-fly synthesis; not the deterministic read check |

Prompts stay **intent-level** (the agent resolves synto's exact flags) except for
the forbidden list above.

**Before re-running a costful step** (import, ingest/compile, approve): inspect vault
state (`synto doctor`, draft/published counts, recent `[synto]` git log). Do not
`add --force`, bulk re-approve, or restart compile unless recovering from a known
failure.

Run **one synto command at a time** — no parallel ingest/compile/approve/serve.

## Consumption sanity check (required before go/no-go)

After articles are **published**, confirm retrieval with:

1. A **real task-wording question** — how you would ask while doing work (not
   "open article titled X").
2. A **deterministic read path** — `find_concept` or `search_articles`, then
   `read_article` on the chosen hit.
3. **Published only** — article `status: published`, not draft/verified in
   `.drafts/`. Synto MCP hides drafts by default (`min_status` → `published`).

## Operator steps

Do these in order. At each **Prompt** step, open (or continue) an agent session
whose working directory is the **vault folder** (after step 3 it exists; before
that, use the parent directory you chose for the vault path).

Do **not** run `synto watch` or leave an MCP server running during steps 5–6
(ingest / review mutations).

### 0. Prepare (operator only)

1. Pick **one book** you may legally process locally (owned copy, license you
   accept, or public-domain text).
2. Choose an **absolute** vault path **outside** `orchestrator-pack`, e.g.
   `/home/you/synto-pilots/<book-slug>-wiki/`.
3. Use a **supported input only**: PDF, Markdown, or plain text via `synto add`.
   EPUB/MOBI/scanned books need pre-conversion — out of scope unless you convert
   to PDF/Markdown yourself first.
4. Decide **scope**: full book or one chapter/sample. Textbook ingest defaults to
   ~25 concepts unless overridden in `synto.toml` — a full book may be capped. Record
   your scope and any ceiling override in the result table.
5. Set a **spend guard** (optional but recommended): max API spend or page/chapter
   limit before ingest; stop and record partial result if exceeded.
6. Open a new agent chat in Cursor (or similar) rooted at that path. Confirm the
   agent is **not** wired as an AO worker for this pack.

### 1. Install synto

**Prompt — paste to vault agent:**

```
Install synto (latest stable, Python 3.11+) on this machine using a standard
package path (pip or uv tool). Verify with `synto --version`. Do not install
anything into the orchestrator-pack repo. Report the installed version and which
install method you used.
```

### 2. Configure LLM provider

**Prompt — paste to vault agent:**

```
Run synto's interactive provider setup so fast (analysis) and heavy (writing)
models are configured. Prefer a local Ollama setup if available; otherwise use
the operator's existing cloud provider. Store API keys only in the user-level synto config
(~/.config/synto/config.toml), never in the vault or in chat. Run `synto doctor`
and report connectivity for both model roles.
```

### 3. Initialize the vault

Replace `<VAULT_PATH>` with your absolute path from step 0.

**Prompt — paste to vault agent:**

```
Create a new synto vault at <VAULT_PATH> (absolute path outside any git
worktree for orchestrator-pack). Initialize the folder structure and confirm
`synto.toml` exists. `cd` into that vault for all following steps. Do not initialize inside orchestrator-pack or inside another existing git
repository — use a fresh directory whose git root (if any) is the vault itself.
```

### 4. Import the book

Replace `<BOOK_FILE>` and `<SOURCE_TYPE>` (e.g. `textbook`, `paper`, `notes`).

**Prompt — paste to vault agent:**

```
Before import: state why <SOURCE_TYPE> fits this book (e.g. textbook vs paper;
remember PDFs default to paper if type is omitted). Import <BOOK_FILE> with that
type. After import, list what landed under `raw/` and `.synto/sources/` and
confirm the source type recorded.
```

### 5. Run ingest and compile

**Prompt — paste to vault agent:**

```
Run the full synto ingest + compile pipeline for this vault (everything needed
to turn the imported book into draft concept articles). Do not auto-publish —
drafts should remain in `wiki/.drafts/` for review. Do not start `watch`. Report
how many draft articles were produced and flag any compile failures.
```

### 6. Review drafts to published

**Prompt — paste to vault agent:**

```
Review every draft article in `wiki/.drafts/` and publish only ones that are
accurate enough for a pilot (reject or leave behind clearly wrong drafts).
Use synto's interactive review/approve workflow — not bulk auto-approve. End
state: at least one concept article with `status: published` under `wiki/` (not
still only in `.drafts/`). Summarize how many you published vs rejected/skipped.
```

### 6b. Lightweight wiki health check

**Prompt — paste to vault agent:**

```
Run `synto doctor`, `synto eval`, and `synto maintain --dry-run` for this vault. Report structural issues
(broken links, missing frontmatter, low-confidence or single-source published
articles) that would undermine the MCP check. Fix only obvious blockers; do not
start concept-identity curation unless the operator asks.
```

### 7. Wire stdio MCP and run the consumption check

**Operator hand steps:**

1. Add synto to your MCP client (example for Cursor — use your **absolute**
   vault path, same environment as step 1):

```json
{
  "mcpServers": {
    "synto": {
      "command": "synto",
      "args": ["serve", "--vault", "/absolute/path/to/your-vault"]
    }
  }
}
```

2. Restart the client. Confirm `synto --version` in the client environment
   matches what the vault agent reported in step 1.

**Prompt — paste to vault agent (with MCP tools enabled):**

```
Using only the synto MCP tools, answer this task-wording question from the
published wiki:

"<TASK_QUESTION>"

Rules:
- Route with `find_concept` or `search_articles`, then read the best match with
  `read_article`. Do NOT call `answer_question` or `synto query`.
- Use only articles with published status (not drafts).
- Run `trace_lineage` (or equivalent) on the article you read and note whether
  the book source backs the excerpt.
- Run `concept inspect` on the concept name and flag homonym/over-merge signs.
- Return: concept name, article path/title, status, excerpt, and one-line lineage note.
```

Pick `<TASK_QUESTION>` yourself — a real design or comprehension question the
book should answer (e.g. "What failure modes matter when choosing between
strong and eventual consistency for this service?").

### 8. Report cost and counts

**Prompt — paste to vault agent:**

```
From synto's local metrics/state for this vault (e.g. doctor output, state DB
metrics, or run logs), report:
- synto version (`synto --version`),
- provider type (local vs cloud),
- approximate total LLM cost or token usage for the end-to-end conversion,
- count of published concept articles under `wiki/`,
- count of drafts still unpublished.
Do not paste API keys.
```

### 9. Record the pilot result (operator only)

Copy the numbers into **Pilot result** below. Add a one-paragraph go/no-go on
**index-routing usefulness** for one book. If the right concept exists but the
task question missed it, note a terminology-recall gap (candidate for
hybrid-search follow-up, not automatic "synto failed").

### 10. Tear down MCP wiring (operator only)

After recording the result:

1. Close agent sessions using the synto MCP server.
2. Remove or disable the `synto` entry from your MCP client config.
3. Restart the client and confirm the synto server no longer appears.
4. Note **teardown done: yes/no** in the result table.

---

## Prompt library (quick reference)

| Step | Intent |
|------|--------|
| 1 | Install synto, verify version |
| 2 | Provider setup + doctor |
| 3 | `init` vault outside pack |
| 4 | `add` book with source type |
| 5 | Ingest + compile to drafts |
| 6 | Review → `published` |
| 6b | `doctor` + `eval` health check |
| 7 | MCP deterministic read for task question |
| 8 | Cost + article counts |
| 10 | MCP teardown (operator) |

---

## Pilot result (operator fills after the run)

| Field | Value |
|-------|-------|
| **Book** | |
| **Source type used** | |
| **Ingest scope (full book / chapter / sample)** | |
| **Concept ceiling (default or override)** | |
| **Vault path (absolute)** | |
| **Synto version** | |
| **Provider (local / cloud)** | |
| **Approximate end-to-end conversion cost** | |
| **Published concept pages** | |
| **Unpublished drafts remaining** | |
| **Task question used** | |
| **Article returned (title + status)** | |
| **Eval / doctor blockers (Y/N + note)** | |
| **Lineage backs excerpt (Y/N)** | |
| **MCP teardown done** | |

### Go / no-go — index routing (one paragraph)

<!-- Operator: did task-wording questions route to relevant published articles?
Recommend follow-up for worker-flow consumption / multi-book / hybrid-search only
if index routing passed. Note terminology-recall gaps separately. -->
