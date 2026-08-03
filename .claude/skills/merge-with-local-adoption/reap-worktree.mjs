#!/usr/bin/env node
// reap-worktree.mjs — reap every process belonging to an Orca worktree.
//
//   node reap-worktree.mjs --path <worktree-abs-path>            # DRY RUN (default)
//   node reap-worktree.mjs --path <worktree-abs-path> --apply     # SIGTERM -> wait -> SIGKILL -> verify
//   node reap-worktree.mjs --scan-orphans [--json]                # census only, kills nothing
//
// Exit codes: 0 = clean (or dry run), 1 = residual processes survived, 2 = refused (unsafe target).
//
// WHY CWD AND NOT env/cgroup/pgid (all three were probed on this host, 2026-08-03):
//   * ORCA_WORKTREE_ID in /proc/<pid>/environ is WRONG on leaked processes — it names the MAIN
//     checkout while the process CWD is the deleted issue worktree. Selecting on it would spare
//     every orphan and target the operator's live checkout. Disqualified.
//   * /proc/<pid>/cgroup does not discriminate: the operator's own session, every Orca PTY shell,
//     and the daemon all share one app-orca scope.
//   * pgid/sid expansion added ZERO processes across five test worktrees and is the only rung that
//     can reach into the operator's own session. Rejected: no benefit, real blast radius.
//   * setsid children keep their CWD both before and after reparenting to init, so CWD catches them.
// A dedicated per-agent cgroup created at SPAWN time would be strictly better, but only Orca can do
// that — this script cleans up after agents it did not launch.
//
// NEVER match on command line. `pkill -f 'synto serve'` would kill three independent per-agent MCP
// servers plus the operator's own. Ownership comes from CWD + process ancestry, never from a name.

// RUNTIME-NEUTRAL: this script never invokes a runtime CLI. The caller supplies the workspace
// inventory as JSON (`--runtime-worktrees <file>`), so swapping Orca for another runtime means
// changing only how that file is produced — see the "Runtime profile" section of SKILL.md.
// Expected shape (extra fields ignored):
//   [ { "path": "/abs/path", "isMain": true|false }, ... ]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const JSONOUT = argv.includes('--json');
const SCAN = argv.includes('--scan-orphans');
const WS_ROOT = (arg('--workspaces-root') || '').replace(/\/+$/, '');

const norm = (c) => (c ? c.replace(/ \(deleted\)$/, '') : null);
const under = (c, root) => { const n = norm(c); return !!n && (n === root || n.startsWith(root + '/')); };

// ---------------------------------------------------------------- safety sets (caller-supplied)
// PROTECTED = every main checkout (never a target, never a victim).
// ROOTS     = the workspace directories the runtime manages worktrees in.
// Both come from the runtime inventory the caller passes in. We fail CLOSED when it is missing,
// empty, or unparseable — acting on an unverified target is the exact mistake this script prevents.
const PROTECTED = new Set();
const ROOTS = new Set();
const inventoryPath = arg('--runtime-worktrees');
if (!inventoryPath) {
  console.error('REFUSE: --runtime-worktrees <file> is required (neutral runtime inventory JSON).');
  process.exit(2);
}
try {
  const rows = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('inventory is not a non-empty array');
  for (const w of rows) {
    if (!w || typeof w.path !== 'string' || !w.path.startsWith('/')) continue;
    const p = w.path.replace(/\/+$/, '');
    if (w.isMain) PROTECTED.add(p);
    else ROOTS.add(p.slice(0, p.lastIndexOf('/')));
  }
  if (!PROTECTED.size) throw new Error('inventory lists no main worktree — refusing to run unprotected');
} catch (e) {
  console.error(`REFUSE: could not read the runtime worktree inventory (${e.message}).`);
  process.exit(2);
}
// Explicit override, for reaping an orphan whose every live sibling is already gone.
if (WS_ROOT) ROOTS.add(WS_ROOT);
if (!ROOTS.size) { console.error('REFUSE: no Orca workspaces root could be determined'); process.exit(2); }
const inAnyRoot = (p) => [...ROOTS].some((r) => r && under(p, r));

// ---------------------------------------------------------------- /proc snapshot
function snapshot() {
  const I = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    let stat; try { stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let cwd = null; try { cwd = fs.readlinkSync(`/proc/${d}/cwd`); } catch { }
    let cmd = ''; try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { }
    let exe = null; try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { }
    // f[19] is `starttime` (stat field 22) — identity token that survives PID reuse.
    I.set(pid, { pid, ppid: Number(f[1]), starttime: f[19], cwd, cmd, exe });
  }
  return I;
}

// ---------------------------------------------------------------- orphan census
if (SCAN) {
  const I = snapshot();
  const groups = new Map();
  for (const p of I.values()) {
    if (!p.cwd || !p.cwd.endsWith(' (deleted)')) continue;
    if (!inAnyRoot(p.cwd)) continue;
    const wt = norm(p.cwd);
    if (!groups.has(wt)) groups.set(wt, []);
    groups.get(wt).push({ pid: p.pid, cmd: p.cmd.slice(0, 120) });
  }
  const total = [...groups.values()].reduce((a, b) => a + b.length, 0);
  const out = { worktrees: groups.size, processes: total, groups: Object.fromEntries(groups) };
  console.log(JSONOUT ? JSON.stringify(out, null, 2)
    : `${total} orphaned process(es) across ${groups.size} removed worktree(s)\n` +
      [...groups].map(([w, ps]) => `  ${ps.length.toString().padStart(3)}  ${w}`).join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------- target validation
const WT = (arg('--path') || '').replace(/\/+$/, '');
if (!WT) { console.error('REFUSE: --path is required (or use --scan-orphans)'); process.exit(2); }
if (!WT.startsWith('/') || WT.includes('/..')) { console.error('REFUSE: --path must be a clean absolute path'); process.exit(2); }

if (PROTECTED.has(WT)) { console.error('REFUSE: target is a main checkout'); process.exit(2); }
if (ROOTS.has(WT) || !inAnyRoot(WT)) {
  console.error(`REFUSE: --path is not a worktree inside a known Orca workspaces root (${[...ROOTS].join(', ')})`);
  process.exit(2);
}

const inWt = (c) => under(c, WT);

// ---------------------------------------------------------------- kill-set computation
function selfChain(I) {                       // us, our ancestors, the Orca daemon above us, init
  const out = new Set();
  let p = process.pid;
  while (p && p !== 0 && I.has(p) && !out.has(p)) { out.add(p); p = I.get(p).ppid; }
  out.add(1);
  return out;
}

function computeKillSet(I) {
  const kids = new Map();
  for (const p of I.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }

  // Seed: CWD rooted in the worktree, an exe resident in it, or an fd still holding it open
  // (the chdir'd-away case).
  const seed = [];
  for (const p of I.values()) {
    if (inWt(p.cwd) || (p.exe && inWt(p.exe))) { seed.push(p.pid); continue; }
    try {
      for (const fd of fs.readdirSync(`/proc/${p.pid}/fd`)) {
        let t; try { t = fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`); } catch { continue; }
        if (inWt(t)) { seed.push(p.pid); break; }
      }
    } catch { }
  }

  // Closure over descendants: catches a live child that chdir'd elsewhere while its parent stayed.
  const set = new Set(seed); const stack = [...seed];
  while (stack.length) { const x = stack.pop(); for (const k of kids.get(x) || []) if (!set.has(k)) { set.add(k); stack.push(k); } }

  const immune = selfChain(I);
  const out = [];
  for (const pid of set) {
    const p = I.get(pid); if (!p) continue;
    if (pid <= 1 || immune.has(pid)) continue;                                  // never us, never init
    const n = norm(p.cwd);
    if (n && PROTECTED.has(n)) continue;                                        // parked in a main checkout
    if (n && inAnyRoot(n) && !inWt(p.cwd)) continue;                            // belongs to a sibling worktree
    out.push(p);
  }
  return out.sort((a, b) => b.pid - a.pid);                                     // leaves before supervisors
}

// ---------------------------------------------------------------- run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// PID-reuse / TOCTOU guard: only signal a pid whose start time still matches the snapshot.
function stillSame(v) {
  try {
    const stat = fs.readFileSync(`/proc/${v.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === v.starttime;
  } catch { return false; }
}
function signal(v, sig) {
  if (v.pid <= 1 || !stillSame(v)) return false;
  try { process.kill(v.pid, sig); return true; } catch { return false; }
}

const victims = computeKillSet(snapshot());
const report = {
  worktree: WT, mode: APPLY ? 'apply' : 'dry-run', count: victims.length,
  victims: victims.map((v) => ({ pid: v.pid, ppid: v.ppid, cwd: v.cwd, cmd: v.cmd.slice(0, 160) })),
};

if (!APPLY) {
  console.log(JSONOUT ? JSON.stringify(report, null, 2)
    : `DRY RUN ${WT}\n${victims.map((v) => `  ${v.pid} ppid=${v.ppid} ${v.cmd.slice(0, 120)}`).join('\n') || '  (none)'}\n` +
      `${victims.length} process(es) would be killed.`);
  process.exit(0);
}

for (const v of victims) signal(v, 'SIGTERM');
let waited = 0;
while (waited < 10000 && victims.some((v) => alive(v.pid))) { await sleep(500); waited += 500; }
const stubborn = victims.filter((v) => alive(v.pid) && stillSame(v));
for (const v of stubborn) signal(v, 'SIGKILL');
await sleep(1000);

// Residual verification re-scans /proc from scratch — never trust the pre-kill snapshot.
const residual = computeKillSet(snapshot());
report.termed = victims.length;
report.sigkilled = stubborn.map((v) => v.pid);
report.residual = residual.map((v) => ({ pid: v.pid, cmd: v.cmd.slice(0, 160) }));
report.clean = residual.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exit(report.clean ? 0 : 1);
