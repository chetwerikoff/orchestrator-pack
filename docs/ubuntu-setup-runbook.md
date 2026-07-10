# Ubuntu / WSL2 setup runbook

Operator guide for standing up **orchestrator-pack** on Ubuntu 22.04+ or WSL2
Ubuntu from scratch. Pack scripts stay **PowerShell** — run them with **pwsh 7+**
on Linux (`defaults.runtime: process` or `tmux` per your AO install).

## Supported platform boundary

| Environment | Supported? | Notes |
|-------------|------------|-------|
| Native Ubuntu / Debian on ext4 | Yes | Primary target |
| WSL2 Ubuntu | Yes | **Only** supported path on Windows |
| Native Windows (PowerShell 5.1, `C:\` repos) | No | Retired — use WSL2 |

**Invariant (decision §P.3):** Clone this pack, target repos, and AO worktrees on
the **Linux filesystem** (`/home/<user>/...`, ext4). Never keep the repo or
`~/.agent-orchestrator` state under **`/mnt/c`** — 9P is slow, breaks inotify,
and reintroduces Windows file-lock behaviour.

On WSL2, set in `/etc/wsl.conf` (then `wsl --shutdown` from Windows):

```ini
[interop]
appendWindowsPath=false
```

A clean `PATH` avoids Windows `node`/`npm` shadowing Linux tools. Re-open the
distro after shutdown.

## 1. Base packages

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

Install **PowerShell 7** (required for all pack scripts). On a clean Ubuntu/WSL2
image the `powershell` package is not in the default apt indexes — register the
Microsoft repository first ([install guide](https://learn.microsoft.com/powershell/scripting/install/install-ubuntu)):

```bash
sudo apt-get update
sudo apt-get install -y wget apt-transport-https software-properties-common

# Register packages.microsoft.com for this Ubuntu release
source /etc/os-release
wget -q "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb"
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb
sudo apt-get update

sudo apt-get install -y powershell
pwsh -Version
```

Install **Node.js 20+** — prefer **nvm** or **NodeSource** over snap for AO/npm
workloads. If you use **snap** for `node`, read §2 before running `npm install -g`.

## 2. Snap `node` and npm prefix (gotcha)

Ubuntu’s snap-packaged `node` often forces a global npm prefix under
`/usr/local`, which is not user-writable without `sudo`.

**Symptom:** `npm install -g @aoagents/ao` fails with `EACCES` on `/usr/local/lib`.

**Fix:** use a user-owned prefix (add to `~/.profile` or `~/.bashrc`):

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Log out and back in (or `source ~/.profile`), then:

```bash
npm install -g @aoagents/ao
ao --version
```

Prefer **nvm** or distro packages from NodeSource if you want to avoid snap
prefix quirks entirely.

## 3. `/snap/bin` on `PATH` (gotcha)

When `node` (or other tools) are installed via snap, binaries live under
`/snap/bin`. That directory is **not** always on `PATH` in non-login shells
(SSH, some IDEs, cron).

**Symptom:** `node: command not found` in a session where `snap list` shows node.

**Fix:** ensure `/snap/bin` is exported:

```bash
export PATH="/snap/bin:$PATH"
```

Persist in `~/.profile` if you rely on snap-provided tools.

## 4. GitHub CLI and pack clone

```bash
type -p curl >/dev/null || sudo apt install -y curl
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
  sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
  sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install -y gh
gh auth login
```

Clone the pack **on ext4** (example):

```bash
git clone https://github.com/chetwerikoff/orchestrator-pack.git \
  "$HOME/projects/orchestrator-pack"
cd "$HOME/projects/orchestrator-pack"
```

## 5. Agent CLIs: `cursor-agent` and `codex`

AO’s Cursor worker plugin expects **`cursor-agent`** (or `agent`) on `PATH`.
Local Codex review expects the **`codex`** CLI.

Install per vendor docs for Linux (versions change — verify with `command -v`):

```bash
# Cursor CLI — follow https://cursor.com/docs/cli (native Linux install)
# Typical check after install:
cursor-agent --version 2>/dev/null || agent --version

# After orchestrator-pack merge for Issue #725 — pack TUI shim (optional but required for AO worker panes):
# pwsh -NoProfile -File scripts/install-cursor-agent-tui-shim.ps1
# pwsh -NoProfile -File scripts/verify-cursor-agent-tui-shim.ps1

# OpenAI Codex CLI — follow current Codex install docs for Linux
codex --version
```

Set **`PACK_REVIEWER`** (`codex` or `claude`) in the shell profile or systemd
unit that starts `ao` — see
[`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md).

## 6. Verify the pack

From the pack root on Linux:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

With strict prerequisites:

```powershell
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
```

## 7. Configure AO

```powershell
Copy-Item agent-orchestrator.yaml.example agent-orchestrator.yaml
# edit projects.*.path to your target repo on ext4, e.g. /home/you/projects/your-repo
```

Merge **Operator adoption** steps after pack PRs land — see
[`docs/migration_notes.md`](migration_notes.md) (Issue #117 and related sections).

Start AO against a target repo explicitly:

```bash
cd "$HOME/projects/your-target-repo"
ao start
```

## Related docs

- [`README.md`](../README.md) — pack overview and Linux baseline
- [`docs/migration_notes.md`](migration_notes.md) — live yaml merge and adoption
- [`docs/ao-0-10-operator-upgrade-runbook.md`](ao-0-10-operator-upgrade-runbook.md) — live AO 0.10.x upgrade (GitHub assets when npm lags)
- [`docs/target_repo_setup.md`](target_repo_setup.md) — target repo checklist
- [`docs/issues_drafts/00-architecture-decisions.md`](issues_drafts/00-architecture-decisions.md) §P — port decision
