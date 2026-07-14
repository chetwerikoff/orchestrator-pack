#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';

const SCRIPT_REL = 'scripts/reachability-purge.mjs';
const MANIFEST_REL = 'scripts/reachability-purge.manifest.json';
const CONFIG_REL = 'scripts/reachability-purge.config.json';
const ISSUE_NUMBER = 819;
const GRAPH_EXTENSIONS = new Set(['.ps1', '.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.sh']);
const BACKUP_PATTERN = /(?:^|\/)[^/]*(?:\.pre-[^/]*|\.(?:bak|backup|old)|~)$/i;

const KEEP_GUARD_TESTS = [
  'scripts/events-optional-consumer-signal-recovery.test.ts',
  'scripts/review-delivery.test.ts',
  'scripts/review-send-reconcile.test.ts',
  'scripts/worker-report-store.test.ts',
  'scripts/worker-status-store.test.ts',
  'scripts/check-no-report-audit-bind.ps1',
];

const REWRITE_LIST_TESTS = [
  'scripts/ao-session-adapter.test.ts',
  'scripts/review-status-consumer.test.ts',
  'scripts/scripted-review-confirmed-delivery-gate.test.ts',
  'scripts/dead-worker-reconcile.test.ts',
  'scripts/review-bulk-send-diagnose.test.ts',
];

const REQUIRED_RETIRED_SHIMS = [
  'scripts/ao',
  'scripts/git',
  'scripts/autonomous-bash-env.sh',
  'scripts/autonomous-orchestrator-surface-bootstrap.sh',
  'scripts/_invoke-system-git.sh',
  'scripts/_resolve-system-git.sh',
];

// Issue #821 owns these deletions. They remain in the pinned #819 analysis graph
// for auditability but are not attributed to #819's deletion formula.
const ISSUE_821_EXTERNAL_DELETIONS = [
  'scripts/_invoke-system-git.sh',
  'scripts/_resolve-system-git.sh',
  'scripts/ao',
  'scripts/ao-autonomous-guard.ps1',
  'scripts/autonomous-bash-env.sh',
  'scripts/autonomous-orchestrator-surface-bootstrap.sh',
  'scripts/check-worker-nudge-gate-adoption.ps1',
  'scripts/git',
  'scripts/git-autonomous-guard.ps1',
  'scripts/git-real-binary',
  'scripts/invoke-orchestrator-claimed-review-run.ps1',
  'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
  'scripts/lib/derive-gh-repo-from-checkout.mjs',
];



function normalizeRel(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function git(repoRoot, args) {
  const result = await runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    allowEmptyStdout: true,
  });
  if (result.ok) return result.stdout;
  const details = [result.stderr, result.stdout, result.error].find((value) => typeof value === 'string' && value.trim());
  throw new Error(details ? `git ${args.join(' ')} failed: ${details.trim()}` : `git ${args.join(' ')} failed`);
}

async function gitTrackedFiles(repoRoot) {
  const raw = await git(repoRoot, ['ls-files', '-z']);
  return raw.split('\0').filter(Boolean).map(normalizeRel).sort();
}

async function gitTrackedFilesAt(repoRoot, ref) {
  const raw = await git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', ref]);
  return raw.split('\0').filter(Boolean).map(normalizeRel).sort();
}

function readText(repoRoot, rel) {
  try {
    return readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return '';
  }
}

async function readTextAt(repoRoot, ref, rel) {
  try {
    return await git(repoRoot, ['show', `${ref}:${rel}`]);
  } catch {
    return '';
  }
}

async function readTextMapAt(repoRoot, ref, paths) {
  const ordered = [...new Set(paths)].sort();
  if (ordered.length === 0) return new Map();
  const result = new Map();
  for (const rel of ordered) {
    result.set(rel, await readTextAt(repoRoot, ref, rel));
  }
  return result;
}

function readTextMap(repoRoot, paths) {
  const result = new Map();
  for (const rel of [...new Set(paths)].sort()) result.set(rel, readText(repoRoot, rel));
  return result;
}

async function loadConfig(repoRoot) {
  const raw = readText(repoRoot, CONFIG_REL);
  if (!raw) throw new Error(`${CONFIG_REL} is missing`);
  const config = JSON.parse(raw);
  if (config.issue !== ISSUE_NUMBER || !/^[0-9a-f]{40}$/i.test(config.analysisBaseCommit ?? '')) {
    throw new Error(`${CONFIG_REL} must pin issue ${ISSUE_NUMBER} and a full analysisBaseCommit SHA`);
  }
  try {
    await git(repoRoot, ['cat-file', '-e', `${config.analysisBaseCommit}^{commit}`]);
  } catch {
    await git(repoRoot, ['fetch', '--no-tags', '--depth=1', 'origin', config.analysisBaseCommit]);
    await git(repoRoot, ['cat-file', '-e', `${config.analysisBaseCommit}^{commit}`]);
  }
  return config;
}

function isTestFile(rel) {
  return /(?:^|\/)(?:[^/]+\.)?(?:test\.(?:ts|mts|cts|js|mjs|cjs)|Tests\.ps1)$/i.test(rel);
}

function isGraphNode(rel) {
  if (rel.startsWith('scripts/')) {
    const ext = path.posix.extname(rel).toLowerCase();
    return GRAPH_EXTENSIONS.has(ext) || ext === '';
  }
  if (/^docs\/[^/]+\.mjs$/i.test(rel)) return true;
  if ((rel.startsWith('tests/') || rel.startsWith('plugins/')) && isTestFile(rel)) return true;
  return false;
}

function isDeletionGraphNode(rel) {
  if (!isGraphNode(rel) || isTestFile(rel)) return false;
  if (/^docs\/[^/]+\.mjs$/i.test(rel)) return true;
  if (!rel.startsWith('scripts/')) return false;
  const ext = path.posix.extname(rel).toLowerCase();
  return ext === '.ps1' || ext === '.sh' || ext === '.mjs' || ext === '';
}

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out);
}

function expandLiteralOrGlob(candidate, trackedSet) {
  const rel = normalizeRel(candidate.replace(/^['"`]|['"`]$/g, ''));
  if (!rel || rel.includes('$') || rel.includes('${')) return [];
  if (!rel.includes('*') && !rel.includes('?')) return trackedSet.has(rel) ? [rel] : [];
  const pattern = globToRegExp(rel);
  return [...trackedSet].filter((item) => pattern.test(item)).sort();
}

function extractRepoPaths(text) {
  const found = new Set();
  const regex = /(?:^|[\s'"`(=:])((?:\.\/)?(?:scripts|docs|tests)\/[A-Za-z0-9_.\-/*?]+(?:\.(?:ps1|mjs|js|cjs|ts|mts|cts|sh|json))?)/gmu;
  let match;
  while ((match = regex.exec(text)) !== null) found.add(normalizeRel(match[1]));
  return [...found].sort();
}

function stripPowerShellForBraces(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '`') quote = null;
      out += ' ';
      continue;
    }
    if (ch === '#' ) break;
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function buildPowerShellLineState(text) {
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let pendingFunction = false;
  let inBlockComment = false;
  const functionDepths = [];
  const states = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    let line = rawLine;
    if (inBlockComment) {
      const close = line.indexOf('#>');
      if (close < 0) {
        states.push({ line: rawLine, code: '', lineNumber: index + 1, inFunction: functionDepths.length > 0 });
        continue;
      }
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('<#');
    if (open >= 0) {
      const close = line.indexOf('#>', open + 2);
      if (close >= 0) line = `${line.slice(0, open)} ${line.slice(close + 2)}`;
      else {
        line = line.slice(0, open);
        inBlockComment = true;
      }
    }
    const clean = stripPowerShellForBraces(line);
    if (/^\s*function\b/i.test(clean)) pendingFunction = true;
    const inFunction = functionDepths.length > 0 || pendingFunction;
    states.push({ line: rawLine, code: line, lineNumber: index + 1, inFunction });
    const opens = (clean.match(/{/g) ?? []).length;
    const closes = (clean.match(/}/g) ?? []).length;
    if (pendingFunction && opens > 0) {
      functionDepths.push(depth + 1);
      pendingFunction = false;
    }
    depth += opens - closes;
    while (functionDepths.length > 0 && depth < functionDepths.at(-1)) functionDepths.pop();
  }
  return states;
}

function resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate) {
  if (!candidate) return null;
  let rel = normalizeRel(candidate.trim().replace(/^['"`]|['"`]$/g, ''));
  rel = rel.replace(/^\$PSScriptRoot\/?/i, `${path.posix.dirname(sourceRel)}/`);
  rel = rel.replace(/^\$Root\/?/i, '');
  rel = rel.replace(/^\$RepoRoot\/?/i, '');
  rel = normalizeRel(rel);
  if (rel.startsWith('../') || rel.startsWith('./')) {
    rel = normalizeRel(path.posix.join(path.posix.dirname(sourceRel), rel));
  }
  const tries = [rel];
  const ext = path.posix.extname(rel);
  if (ext === '.js') tries.push(rel.slice(0, -3) + '.ts', rel.slice(0, -3) + '.mjs', rel.slice(0, -3) + '.mts');
  if (!ext) tries.push(`${rel}.ps1`, `${rel}.mjs`, `${rel}.js`, `${rel}.ts`, `${rel}.sh`);
  for (const item of tries) if (trackedSet.has(item)) return item;
  const abs = path.resolve(repoRoot, rel);
  if (abs.startsWith(repoRoot) && existsSync(abs)) return normalizeRel(path.relative(repoRoot, abs));
  return null;
}

function resolvePowerShellExpression(repoRoot, trackedSet, sourceRel, expression, variables) {
  const expr = expression.trim().replace(/[;|].*$/, '').trim();
  const direct = expr.match(/^['"]([^'"]+)['"]$/);
  if (direct) return resolveExistingPath(repoRoot, trackedSet, sourceRel, direct[1]);
  const variable = expr.match(/^\$([A-Za-z_][A-Za-z0-9_:]*)$/);
  if (variable && variables.has(variable[1].toLowerCase())) {
    return resolveExistingPath(repoRoot, trackedSet, sourceRel, variables.get(variable[1].toLowerCase()));
  }
  const join = expr.match(/^\(?\s*Join-Path\s+([^\s)]+)\s+['"]([^'"]+)['"]\s*\)?/i);
  if (join) {
    const base = join[1];
    const tail = join[2];
    let basePath = null;
    if (/^\$PSScriptRoot$/i.test(base)) basePath = path.posix.dirname(sourceRel);
    else if (/^\$(?:Root|RepoRoot|PackRoot)$/i.test(base)) basePath = '';
    else {
      const baseVar = base.match(/^\$([A-Za-z_][A-Za-z0-9_:]*)$/);
      if (baseVar && variables.has(baseVar[1].toLowerCase())) basePath = variables.get(baseVar[1].toLowerCase());
    }
    if (basePath !== null) return resolveExistingPath(repoRoot, trackedSet, sourceRel, normalizeRel(path.posix.join(basePath, tail)));
  }
  return null;
}

function inferPowerShellPossibleTargets(repoRoot, trackedSet, sourceRel, expression, variables) {
  const candidates = new Set();
  const add = (value) => {
    const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, value);
    if (target) candidates.add(target);
  };

  const expr = expression.trim();
  for (const match of expr.matchAll(/['"]([^'"]+\.(?:ps1|mjs|js|cjs|ts|mts|cts|sh))['"]/gi)) {
    const literal = normalizeRel(match[1]);
    add(literal);
    add(normalizeRel(path.posix.join(path.posix.dirname(sourceRel), literal)));
    if (!literal.includes('/')) {
      for (const tracked of trackedSet) {
        if (path.posix.basename(tracked).toLowerCase() === literal.toLowerCase()) candidates.add(tracked);
      }
    }
  }

  for (const match of expr.matchAll(/\$([A-Za-z_][A-Za-z0-9_:]*)/g)) {
    const value = variables.get(match[1].toLowerCase());
    if (value) add(value);
  }

  return [...candidates].sort();
}

function powerShellAssignments(repoRoot, trackedSet, sourceRel, states) {
  const variables = new Map();
  for (const state of states) {
    const match = state.code.match(/^\s*\$([A-Za-z_][A-Za-z0-9_:]*)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const expression = match[2].trim();
    const direct = expression.match(/^['"]([^'"]+)['"]$/);
    if (direct) {
      variables.set(name, normalizeRel(direct[1]));
      continue;
    }
    const join = expression.match(/^\(?\s*Join-Path\s+([^\s)]+)\s+['"]([^'"]+)['"]\s*\)?/i);
    if (join) {
      let basePath = null;
      if (/^\$PSScriptRoot$/i.test(join[1])) basePath = path.posix.dirname(sourceRel);
      else if (/^\$(?:Root|RepoRoot|PackRoot)$/i.test(join[1])) basePath = '';
      else {
        const baseVar = join[1].match(/^\$([A-Za-z_][A-Za-z0-9_:]*)$/);
        if (baseVar && variables.has(baseVar[1].toLowerCase())) basePath = variables.get(baseVar[1].toLowerCase());
      }
      if (basePath !== null) variables.set(name, normalizeRel(path.posix.join(basePath, join[2])));
      continue;
    }
    const variable = expression.match(/^\$([A-Za-z_][A-Za-z0-9_:]*)$/);
    if (variable && variables.has(variable[1].toLowerCase())) variables.set(name, variables.get(variable[1].toLowerCase()));
  }
  return variables;
}

function inferLinePossibleTargets(repoRoot, trackedSet, sourceRel, line, variables = null) {
  const targets = new Set();
  for (const candidate of extractRepoPaths(line)) {
    const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
    if (target) targets.add(target);
  }
  const joined = /path\.(?:join|resolve)\(\s*(?:repoRoot|root|packRoot|process\.cwd\(\))\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)/g;
  let joinMatch;
  while ((joinMatch = joined.exec(line)) !== null) {
    const candidate = joinMatch[2] ? `${joinMatch[1]}/${joinMatch[2]}` : joinMatch[1];
    const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
    if (target) targets.add(target);
  }
  if (variables) {
    for (const [variableName, variableTarget] of variables) {
      if (new RegExp(`\\$${variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) {
        targets.add(variableTarget);
      }
    }
  }
  return [...targets].sort();
}

function parsePowerShell(repoRoot, trackedSet, sourceRel, text) {
  const trustedEdges = [];
  const suspectEdges = [];
  const unresolved = [];
  const references = [];
  const states = buildPowerShellLineState(text);
  const variables = powerShellAssignments(repoRoot, trackedSet, sourceRel, states);
  for (const targetPath of variables.values()) {
    const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, targetPath);
    if (target) references.push({ source: sourceRel, target, line: 1, kind: 'resolved-path-assignment' });
  }

  const pushUnresolved = (state, kind, expression, possibleTargets = []) => {
    unresolved.push({
      source: sourceRel,
      line: state.lineNumber,
      kind,
      expression: expression.trim(),
      possibleTargets: [...new Set(possibleTargets)].sort(),
      foldedIntoZeroReachability: false,
      evidence: possibleTargets.length > 0
        ? 'Static parse could not resolve a literal target; inferred same-directory candidates are held.'
        : 'Static parse could not resolve a literal repository target; inventoried for manual disposition.',
    });
  };

  for (const state of states) {
    const line = state.code;
    const dot = line.match(/^\s*\.\s+(.+?)\s*$/);
    if (dot) {
      const target = resolvePowerShellExpression(repoRoot, trackedSet, sourceRel, dot[1], variables);
      if (state.inFunction) {
        const possibleTargets = target
          ? [target]
          : inferPowerShellPossibleTargets(repoRoot, trackedSet, sourceRel, dot[1], variables);
        suspectEdges.push({
          source: sourceRel,
          line: state.lineNumber,
          target,
          possibleTargets,
          expression: dot[1].trim(),
          consumerScope: 'unknown',
          disposition: sourceRel === 'scripts/lib/WorkerStatusStore.ps1' ? 'broken' : 'unknown',
          evidence: sourceRel === 'scripts/lib/WorkerStatusStore.ps1'
            ? 'Issue #819 cites the WorkerStatusStore in-function dot-source outage class; cross-scope definitions were unavailable.'
            : 'unverified; fail-safe KEEP pending same-scope or cross-scope proof',
        });
      } else if (target) {
        trustedEdges.push({ source: sourceRel, target, line: state.lineNumber, kind: 'top-level-dot-source' });
      } else {
        pushUnresolved(state, 'dot-source', dot[1]);
      }
      continue;
    }

    const call = line.match(/(?:^|[;|])\s*&\s+(\([^)]*\)|'[^']+'|"[^"]+"|\$[A-Za-z_][A-Za-z0-9_:]*|[^\s;|]+)/);
    if (call) {
      const target = resolvePowerShellExpression(repoRoot, trackedSet, sourceRel, call[1], variables);
      if (target) trustedEdges.push({ source: sourceRel, target, line: state.lineNumber, kind: 'direct-call-operator' });
      else if (/\.(?:ps1|mjs|js|sh)\b/i.test(call[1])) pushUnresolved(state, 'call-operator', call[1]);
    }

    const hostWithScript = line.match(/(?:^|[;|])\s*&?\s*(?:node|node\.exe|\$[A-Za-z_][A-Za-z0-9_:]*node[A-Za-z0-9_:]*)\s+(\([^)]*\)|'[^']+'|"[^"]+"|\$[A-Za-z_][A-Za-z0-9_:]*|[^\s;|]+)/i);
    if (hostWithScript) {
      const target = resolvePowerShellExpression(repoRoot, trackedSet, sourceRel, hostWithScript[1], variables);
      if (target) trustedEdges.push({ source: sourceRel, target, line: state.lineNumber, kind: 'node-script' });
      else if (/\.(?:mjs|js|cjs|ts|mts|cts)\b|\$[A-Za-z_]/i.test(hostWithScript[1])) pushUnresolved(state, 'node-script', hostWithScript[1]);
    }

    const pwsh = line.match(/\bpwsh\b[^#\r\n]*?\s-File\s+(\([^)]*\)|'[^']+'|"[^"]+"|\$[A-Za-z_][A-Za-z0-9_:]*|[^\s;|]+)/i);
    if (pwsh) {
      const target = resolvePowerShellExpression(repoRoot, trackedSet, sourceRel, pwsh[1], variables);
      if (target) trustedEdges.push({ source: sourceRel, target, line: state.lineNumber, kind: 'pwsh-file' });
      else pushUnresolved(state, 'pwsh-file', pwsh[1]);
    }

    if (/\bStart-Process\b[^#\r\n]*\s-FilePath\b/i.test(line)) {
      const possibleTargets = inferLinePossibleTargets(repoRoot, trackedSet, sourceRel, line, variables);
      if (possibleTargets.length > 0) pushUnresolved(state, 'start-process', line, possibleTargets);
    }

    for (const candidate of extractRepoPaths(line)) {
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
      if (target) references.push({ source: sourceRel, target, line: state.lineNumber, kind: 'literal-reference' });
    }
  }
  return { trustedEdges, suspectEdges, unresolved, references };
}

function jsAssignments(repoRoot, trackedSet, sourceRel, text) {
  const variables = new Map();
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:join|resolve)\(\s*([A-Za-z_$][\w$]*|process\.cwd\(\))\s*,([\s\S]*?)\)(?:\.replace\([^;]*\))?\s*;/g;
  let changed = true;
  while (changed) {
    changed = false;
    assignment.lastIndex = 0;
    let match;
    while ((match = assignment.exec(text)) !== null) {
      if (variables.has(match[1])) continue;
      const first = match[2];
      let basePath = null;
      if (/^(?:repoRoot|root|packRoot|process\.cwd\(\))$/.test(first)) basePath = '';
      else if (variables.has(first)) basePath = variables.get(first);
      if (basePath === null) continue;
      const parts = [];
      const strings = /['"]([^'"]+)['"]/g;
      let stringMatch;
      while ((stringMatch = strings.exec(match[3])) !== null) parts.push(stringMatch[1]);
      if (parts.length === 0) continue;
      variables.set(match[1], normalizeRel(path.posix.join(basePath, ...parts)));
      changed = true;
    }
  }
  const urlCall = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fileURLToPath\(\s*new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)\s*\)/g;
  let match;
  while ((match = urlCall.exec(text)) !== null) variables.set(match[1], normalizeRel(path.posix.join(path.posix.dirname(sourceRel), match[2])));
  return variables;
}

function resolveJsSpecifier(repoRoot, trackedSet, sourceRel, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('scripts/') && !specifier.startsWith('docs/')) return null;
  const candidate = specifier.startsWith('.')
    ? normalizeRel(path.posix.join(path.posix.dirname(sourceRel), specifier))
    : normalizeRel(specifier);
  return resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
}

function parseJavaScript(repoRoot, trackedSet, sourceRel, text) {
  const trustedEdges = [];
  const suspectEdges = [];
  const unresolved = [];
  const references = [];
  const variables = jsAssignments(repoRoot, trackedSet, sourceRel, text);
  const lines = text.split(/\r?\n/);
  for (const targetPath of variables.values()) {
    const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, targetPath);
    if (target) references.push({ source: sourceRel, target, line: 1, kind: 'resolved-path-assignment' });
  }

  const importRegex = /(?:import|export)\s+(?:[^;]*?\bfrom\s+)?['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  let importMatch;
  while ((importMatch = importRegex.exec(text)) !== null) {
    const specifier = importMatch[1] ?? importMatch[2];
    const target = resolveJsSpecifier(repoRoot, trackedSet, sourceRel, specifier);
    if (target) {
      const line = text.slice(0, importMatch.index).split(/\r?\n/).length;
      trustedEdges.push({ source: sourceRel, target, line, kind: 'module-import' });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const joinRegex = /path\.(?:join|resolve)\(\s*(?:repoRoot|root|packRoot|process\.cwd\(\))\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)/g;
    let join;
    while ((join = joinRegex.exec(line)) !== null) {
      const candidate = join[2] ? `${join[1]}/${join[2]}` : join[1];
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
      if (target) references.push({ source: sourceRel, target, line: lineNumber, kind: 'literal-reference' });
    }

    for (const candidate of extractRepoPaths(line)) {
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
      if (target) references.push({ source: sourceRel, target, line: lineNumber, kind: 'literal-reference' });
    }

    if (/\bStart-Process\b[^\r\n]*\s-FilePath\b/i.test(line)) {
      const possibleTargets = inferLinePossibleTargets(repoRoot, trackedSet, sourceRel, line);
      if (possibleTargets.length > 0) {
        unresolved.push({
          source: sourceRel,
          line: lineNumber,
          kind: 'start-process',
          expression: line.trim(),
          possibleTargets,
          foldedIntoZeroReachability: false,
          evidence: 'Start-Process dispatch is treated as an unresolved dynamic invocation; inferred repository-local targets are held until a dedicated parser proves them.',
        });
      }
    }

    const spawn = line.match(/\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(\s*([^,\n]+)/);
    if (spawn) {
      const expression = spawn[1].trim();
      let target = null;
      const literal = expression.match(/^['"]([^'"]+)['"]$/);
      if (literal) target = resolveExistingPath(repoRoot, trackedSet, sourceRel, literal[1]);
      const variable = expression.match(/^([A-Za-z_$][\w$]*)$/);
      if (!target && variable && variables.has(variable[1])) target = variables.get(variable[1]);
      const joined = expression.match(/^path\.(?:join|resolve)\(\s*(?:repoRoot|root|packRoot|process\.cwd\(\))\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)$/);
      if (!target && joined) {
        const candidate = joined[2] ? `${joined[1]}/${joined[2]}` : joined[1];
        target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
      }
      if (target) trustedEdges.push({ source: sourceRel, target, line: lineNumber, kind: 'node-child-process' });
      else if (!/^['"](?:node|git|gh|pwsh|bash|sh|ao)['"]$/i.test(expression)) {
        unresolved.push({
          source: sourceRel,
          line: lineNumber,
          kind: 'node-child-process',
          expression,
          possibleTargets: [],
          foldedIntoZeroReachability: false,
          evidence: 'Non-literal child-process target; no repository-local literal target inferred.',
        });
      }
      for (const [variableName, variableTarget] of variables) {
        if (new RegExp(`\\b${variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line)) {
          trustedEdges.push({ source: sourceRel, target: variableTarget, line: lineNumber, kind: 'node-child-process-argument' });
        }
      }
      for (const candidate of extractRepoPaths(line)) {
        const argumentTarget = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
        if (argumentTarget) trustedEdges.push({ source: sourceRel, target: argumentTarget, line: lineNumber, kind: 'node-child-process-literal-argument' });
      }
    }
  }
  return { trustedEdges, suspectEdges, unresolved, references };
}

function parseShell(repoRoot, trackedSet, sourceRel, text) {
  const trustedEdges = [];
  const suspectEdges = [];
  const unresolved = [];
  const references = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const source = line.match(/^\s*(?:source|\.)\s+['"]?([^'"\s]+)['"]?/);
    if (source) {
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, source[1]);
      if (target) trustedEdges.push({ source: sourceRel, target, line: lineNumber, kind: 'shell-source' });
      else if (source[1].includes('$')) unresolved.push({ source: sourceRel, line: lineNumber, kind: 'shell-source', expression: source[1], possibleTargets: [], foldedIntoZeroReachability: false, evidence: 'Non-literal shell source target.' });
    }
    const invocation = line.match(/^\s*(?:exec\s+)?(?:bash|sh|pwsh\s+-[^\n]*?-File)\s+['"]?([^'"\s]+)['"]?/);
    if (invocation) {
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, invocation[1]);
      if (target) trustedEdges.push({ source: sourceRel, target, line: lineNumber, kind: 'shell-direct-invocation' });
      else if (invocation[1].includes('$')) unresolved.push({ source: sourceRel, line: lineNumber, kind: 'shell-direct-invocation', expression: invocation[1], possibleTargets: [], foldedIntoZeroReachability: false, evidence: 'Non-literal shell invocation target.' });
    }
    for (const candidate of extractRepoPaths(line)) {
      const target = resolveExistingPath(repoRoot, trackedSet, sourceRel, candidate);
      if (target) references.push({ source: sourceRel, target, line: lineNumber, kind: 'literal-reference' });
    }
  }
  return { trustedEdges, suspectEdges, unresolved, references };
}

function parseNode(repoRoot, trackedSet, sourceRel, text) {
  const ext = path.posix.extname(sourceRel).toLowerCase();
  if (ext === '.ps1') return parsePowerShell(repoRoot, trackedSet, sourceRel, text);
  if (['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts'].includes(ext)) return parseJavaScript(repoRoot, trackedSet, sourceRel, text);
  if (ext === '.sh' || ext === '') return parseShell(repoRoot, trackedSet, sourceRel, text);
  return { trustedEdges: [], suspectEdges: [], unresolved: [], references: [] };
}

function commandLineRepoPaths(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return [];
  const invocationLike =
    /(?:^|[;&|]\s*|\b)(?:pwsh|powershell)(?:\.exe)?\b[^#\r\n]*?(?:-File\s+|&\s*)/i.test(line)
    || /(?:^|[;&|]\s*|\b)(?:node|bash|sh)\b[^#\r\n]*?(?:\.\/)?(?:scripts|docs)\//i.test(line)
    || /^\s*(?:[-+*]\s+|\$\s+|>\s+)?(?:\.\/)?scripts\/[A-Za-z0-9_.\-/]+/i.test(line)
    || /`(?:pwsh|powershell|node|bash|sh)\b[^`]*(?:scripts|docs)\//i.test(line)
    || /`(?:\.\/)?scripts\/[A-Za-z0-9_.\-/]+/i.test(line);
  return invocationLike ? extractRepoPaths(line) : [];
}

function workflowRunLines(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let blockIndent = null;
  for (const raw of lines) {
    const indent = raw.match(/^\s*/)[0].length;
    if (blockIndent !== null) {
      if (raw.trim() && indent < blockIndent) blockIndent = null;
      else {
        output.push(raw.slice(Math.min(blockIndent, raw.length)));
        continue;
      }
    }
    const run = raw.match(/^(\s*)run:\s*(.*)$/);
    if (!run) continue;
    const tail = run[2].trim();
    if (tail === '|' || tail === '>' || tail === '|-' || tail === '>-') blockIndent = run[1].length + 2;
    else if (tail) output.push(tail);
  }
  return output;
}

function rootRecords(repoRoot, tracked, trackedSet, readSource) {
  const production = new Map();
  const tests = new Map();
  const add = (map, rel, reason) => {
    if (!trackedSet.has(rel)) return;
    if (!map.has(rel)) map.set(rel, new Set());
    map.get(rel).add(reason);
  };

  add(production, 'scripts/verify.ps1', 'binding: gate aggregator');
  add(production, 'scripts/check-reusable.ps1', 'binding: reusable-pack guard');
  for (const aggregator of ['scripts/verify.ps1', 'scripts/check-reusable.ps1']) {
    for (const candidate of extractRepoPaths(readSource(aggregator))) {
      for (const expanded of expandLiteralOrGlob(candidate, trackedSet)) {
        if (isTestFile(expanded)) add(tests, expanded, `aggregator:${aggregator}`);
        else if (isGraphNode(expanded)) add(production, expanded, `aggregator:${aggregator}`);
      }
    }
  }
  for (const rel of tracked.filter((item) => /^docs\/[^/]+\.mjs$/i.test(item))) add(production, rel, 'binding: docs/*.mjs first-party product root');

  for (const workflow of tracked.filter((item) => item.startsWith('.github/workflows/') && /\.ya?ml$/i.test(item))) {
    for (const line of workflowRunLines(readSource(workflow))) {
      for (const candidate of commandLineRepoPaths(line)) {
        for (const expanded of expandLiteralOrGlob(candidate, trackedSet)) {
          if (isTestFile(expanded)) add(tests, expanded, `workflow:${workflow}`);
          else if (isGraphNode(expanded)) add(production, expanded, `workflow:${workflow}`);
        }
      }
    }
  }

  const packageJson = JSON.parse(readSource('package.json'));
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    for (const candidate of commandLineRepoPaths(String(command))) {
      for (const expanded of expandLiteralOrGlob(candidate, trackedSet)) {
        if (isTestFile(expanded)) add(tests, expanded, `package.json:${name}`);
        else if (isGraphNode(expanded)) add(production, expanded, `package.json:${name}`);
      }
    }
    if (/\bvitest\b/.test(String(command))) {
      for (const rel of tracked.filter((item) => isTestFile(item) && /\.(?:ts|mts|cts|js|mjs|cjs)$/i.test(item))) add(tests, rel, `package.json:${name}:vitest-discovery`);
    }
  }

  for (const rel of tracked.filter((item) => /\.Tests\.ps1$/i.test(item))) add(tests, rel, 'binding: Pester conventional discovery');

  const operatorDocs = tracked.filter((item) => item === 'README.md' || item === 'AGENTS.md' || item === 'CLAUDE.md' || item === 'docs/migration_notes.md' || (item.startsWith('docs/') && item.endsWith('.md') && !item.startsWith('docs/issues_drafts/') && !item.startsWith('docs/declarations/')));
  for (const doc of operatorDocs) {
    for (const line of readSource(doc).split(/\r?\n/)) {
      for (const candidate of commandLineRepoPaths(line)) {
        for (const expanded of expandLiteralOrGlob(candidate, trackedSet)) {
          if (isTestFile(expanded)) add(tests, expanded, `operator-doc:${doc}`);
          else if (isGraphNode(expanded)) add(production, expanded, `operator-doc:${doc}`);
        }
      }
    }
  }

  const serialize = (map) => [...map.entries()].map(([file, reasons]) => ({ path: file, reasons: [...reasons].sort() })).sort((a, b) => a.path.localeCompare(b.path));
  return { production: serialize(production), tests: serialize(tests) };
}

function transitiveClosure(roots, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of adjacency.get(current) ?? []) if (!seen.has(target)) queue.push(target);
  }
  return [...seen].sort();
}

function manifestMigrationNote(repoRoot) {
  const text = readText(repoRoot, 'docs/migration_notes.md');
  const lower = text.toLowerCase();
  const namesRetired = REQUIRED_RETIRED_SHIMS.every((item) => lower.includes(path.posix.basename(item).toLowerCase()));
  const pathCleanup = /remove[^\n]{0,160}(?:path|profile)|(?:path|profile)[^\n]{0,160}remove/i.test(text);
  const replacement = /regular[^\n]{0,120}\bao\b[^\n]{0,120}\bgit\b[^\n]{0,120}(?:on\s+path|path)/i.test(text);
  const explicitlyNotAuthorized = /does\s+not\s+(?:retire|authorize)|not\s+yet\s+(?:safe|authorized)|keep\s+the\s+existing/i.test(text);
  const authorized = namesRetired && pathCleanup && replacement && !explicitlyNotAuthorized;
  return { namesRetired, pathCleanup, replacement, explicitlyNotAuthorized, authorized, presentWithRequiredFields: authorized };
}

function classifySupersededSurface(node, text, inboundTrustedEdges) {
  const tokens = [];
  const checks = [
    [/\bao\s+events\b/i, 'ao events'],
    [/\bao\s+report\b/i, 'ao report'],
    [/\bao\s+status\b[^\r\n]*--reports/i, 'ao status --reports'],
    [new RegExp('\\bao\\s+' + 'review\\s+(?:send|execute|list)\\b', 'i'), 'ao-review send|execute|list'],
    [/\/sessions\/[^/\s]+\/reports\b/i, 'GET /sessions/{id}/reports'],
    [/fail-stale/i, 'reviews/runs/{id}/fail-stale'],
    [/\bdisplayName\b/i, 'removed displayName field'],
    [/\bprNumber\b/i, 'removed prNumber field'],
  ];
  for (const [pattern, label] of checks) if (pattern.test(text)) tokens.push(label);
  if (tokens.length === 0) return null;
  return {
    path: node,
    tokens: [...new Set(tokens)].sort(),
    disposition: inboundTrustedEdges.length === 0 ? 'held-uncorroborated' : 'held-live-callers',
    evidence: inboundTrustedEdges.length === 0
      ? 'Deprecated vocabulary was found, but token presence alone is not proof that the whole node is superseded; fail-safe KEEP.'
      : `The node has ${inboundTrustedEdges.length} trusted inbound edge(s); superseded token presence cannot license deleting a live container.`,
    inboundTrustedEdges,
  };
}

function configDrivenDynamicRows(repoRoot, tracked, trackedSet, readSource) {
  const rows = [];
  for (const rel of tracked.filter((item) => item.startsWith('scripts/') && /\.(?:json|ya?ml)$/i.test(item))) {
    if (rel === MANIFEST_REL) continue;
    const text = readSource(rel);
    const stringRegex = /["']([^"'\r\n]+\.(?:ps1|mjs|js|cjs|ts|mts|cts|sh))["']/gi;
    let match;
    while ((match = stringRegex.exec(text)) !== null) {
      const raw = normalizeRel(match[1]);
      const candidates = [
        resolveExistingPath(repoRoot, trackedSet, rel, raw),
        resolveExistingPath(repoRoot, trackedSet, rel, normalizeRel(path.posix.join(path.posix.dirname(rel), raw))),
      ].filter(Boolean);
      if (candidates.length === 0 && !raw.includes('/')) {
        for (const candidate of tracked) {
          if (path.posix.basename(candidate) === raw && candidate.startsWith(path.posix.dirname(rel))) candidates.push(candidate);
        }
      }
      if (candidates.length > 0) {
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        rows.push({
          source: rel,
          line,
          kind: 'config-driven-script-target',
          expression: match[0],
          possibleTargets: [...new Set(candidates)].sort(),
          foldedIntoZeroReachability: false,
          evidence: 'A tracked config names an executable target; config-driven dispatch is held as an unresolved dynamic invocation rather than trusted as a static edge.',
        });
      }
    }
  }
  return rows;
}

export async function buildManifest(repoRoot = repoRootFromScript()) {
  const config = await loadConfig(repoRoot);
  const baseRef = config.analysisBaseCommit;
  const baseSha = (await git(repoRoot, ['rev-parse', baseRef])).trim();
  const tracked = await gitTrackedFilesAt(repoRoot, baseRef);
  const trackedSet = new Set(tracked);
  const currentTracked = await gitTrackedFiles(repoRoot);
  const currentTrackedSet = new Set(currentTracked);
  const deletedFromBase = tracked.filter((item) => !currentTrackedSet.has(item));
  const externalPrerequisiteDeletionSet = new Set(ISSUE_821_EXTERNAL_DELETIONS);
  const retainedDeletedNodes = deletedFromBase.filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item));
  const analysisTracked = [...new Set([...currentTracked, ...retainedDeletedNodes])].sort();
  const analysisTrackedSet = new Set(analysisTracked);
  const graphNodes = analysisTracked.filter(isGraphNode).sort();
  const currentGraphNodes = currentTracked.filter(isGraphNode).sort();
  const deletionGraphNodes = analysisTracked.filter(isDeletionGraphNode).sort();
  const sourceInputs = new Set(currentGraphNodes);
  for (const rel of currentTracked) {
    if (rel.startsWith('docs/declarations/')) continue;
    if (rel === MANIFEST_REL) continue;
    if (/\.(?:ps1|mjs|js|cjs|ts|mts|cts|sh|json|ya?ml|md)$/i.test(rel) || rel === 'package.json' || rel === 'AGENTS.md' || rel === 'CLAUDE.md') sourceInputs.add(rel);
  }
  const sourceMap = readTextMap(repoRoot, [...sourceInputs]);
  const readSource = (rel) => sourceMap.get(rel) ?? '';
  const roots = rootRecords(repoRoot, currentTracked, currentTrackedSet, readSource);
  const trustedEdges = [];
  const suspectEdges = [];
  const unresolvedDynamicForms = [];
  const references = [];
  for (const node of currentGraphNodes) {
    const parsed = parseNode(repoRoot, analysisTrackedSet, node, readSource(node));
    trustedEdges.push(...parsed.trustedEdges);
    suspectEdges.push(...parsed.suspectEdges);
    unresolvedDynamicForms.push(...parsed.unresolved);
    references.push(...parsed.references);
  }
  unresolvedDynamicForms.push(...configDrivenDynamicRows(repoRoot, currentTracked, analysisTrackedSet, readSource));

  const graphNodesByBasename = new Map();
  for (const node of graphNodes) {
    const basename = path.posix.basename(node);
    if (!graphNodesByBasename.has(basename)) graphNodesByBasename.set(basename, []);
    graphNodesByBasename.get(basename).push(node);
  }
  for (const testPath of roots.tests.map((item) => item.path).filter((item) => currentTrackedSet.has(item))) {
    const text = readSource(testPath);
    const literalName = /['"]([^/'"\r\n]+\.(?:ps1|mjs|js|cjs|ts|mts|cts|sh))['"]/gi;
    let match;
    while ((match = literalName.exec(text)) !== null) {
      const candidates = graphNodesByBasename.get(match[1]) ?? [];
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      if (candidates.length === 1) {
        trustedEdges.push({ source: testPath, target: candidates[0], line, kind: 'test-unique-basename-dependency' });
      } else if (candidates.length > 1) {
        unresolvedDynamicForms.push({
          source: testPath,
          line,
          kind: 'test-basename-dynamic-target',
          expression: match[0],
          possibleTargets: candidates.sort(),
          foldedIntoZeroReachability: false,
          evidence: 'A test names an executable by basename, but more than one tracked target matches; all matches are held.',
        });
      }
    }
  }

  const edgeKey = (edge) => `${edge.source}\0${edge.target ?? ''}\0${edge.line}\0${edge.kind ?? ''}\0${edge.expression ?? ''}\0${(edge.possibleTargets ?? []).join(',')}`;
  const dedupe = (items) => [...new Map(items.map((item) => [edgeKey(item), item])).values()];
  const testRootSet = new Set(roots.tests.map((item) => item.path));
  for (const ref of references) {
    if (testRootSet.has(ref.source) && analysisTrackedSet.has(ref.target) && isGraphNode(ref.target)) {
      trustedEdges.push({ ...ref, kind: 'test-literal-dependency' });
    }
  }

  const trusted = dedupe(trustedEdges).filter((edge) => analysisTrackedSet.has(edge.target)).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const brokenByKey = new Map((config.knownBrokenSuspectEdges ?? []).map((row) => [`${row.source}:${row.line}`, row]));
  const suspects = dedupe(suspectEdges).map((edge) => {
    const known = brokenByKey.get(`${edge.source}:${edge.line}`);
    if (!known) return edge;
    return {
      ...edge,
      disposition: 'broken',
      consumerScope: 'cross-scope',
      evidence: known.evidence,
      possibleTargets: [...new Set([...(edge.possibleTargets ?? []), ...(known.possibleTargets ?? [])])].sort(),
    };
  }).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  for (const edge of suspects) {
    if (edge.target || (edge.possibleTargets ?? []).length === 0) continue;
    unresolvedDynamicForms.push({
      source: edge.source,
      line: edge.line,
      kind: 'in-function-dot-source-dynamic-target',
      expression: edge.expression,
      possibleTargets: edge.possibleTargets,
      foldedIntoZeroReachability: false,
      evidence: 'The in-function dot-source target is dynamic; every inferred possible target is held in addition to the explicit suspect-edge disposition.',
    });
  }
  let unresolved = dedupe(unresolvedDynamicForms).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const literalReferences = dedupe(references).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  const allRootPaths = [...roots.production, ...roots.tests].map((item) => item.path).filter((item) => currentTrackedSet.has(item));
  const reachableNodes = transitiveClosure(allRootPaths, trusted).filter((item) => analysisTrackedSet.has(item));
  const reachableSet = new Set(reachableNodes);
  const zeroReachabilityNodes = deletionGraphNodes.filter((item) => !reachableSet.has(item));
  const zeroSet = new Set(zeroReachabilityNodes);

  const uniqueByBasename = new Map();
  for (const node of deletionGraphNodes) {
    const name = path.posix.basename(node);
    if (!uniqueByBasename.has(name)) uniqueByBasename.set(name, []);
    uniqueByBasename.get(name).push(node);
  }
  const rootSourceSet = new Set([
    ...roots.production.map((row) => row.path),
    ...roots.tests.map((row) => row.path),
    'package.json',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/migration_notes.md',
  ]);
  const referenceUncertainty = [];
  for (const [source, text] of sourceMap) {
    if (source.startsWith('docs/declarations/')) continue;
    const sourceIsLive = reachableSet.has(source) || rootSourceSet.has(source) || source.startsWith('.github/workflows/');
    if (!sourceIsLive) continue;
    const found = new Set();
    for (const candidate of extractRepoPaths(text)) {
      const target = resolveExistingPath(repoRoot, analysisTrackedSet, source, candidate);
      if (target && zeroSet.has(target) && target !== source) found.add(target);
    }
    const literalName = /['"]([^'"\r\n]+\.(?:ps1|mjs|sh))['"]/gi;
    let match;
    while ((match = literalName.exec(text)) !== null) {
      const raw = normalizeRel(match[1]);
      const direct = resolveExistingPath(repoRoot, analysisTrackedSet, source, raw);
      if (direct && zeroSet.has(direct) && direct !== source) found.add(direct);
      const candidates = uniqueByBasename.get(path.posix.basename(raw)) ?? [];
      if (candidates.length === 1 && zeroSet.has(candidates[0]) && candidates[0] !== source) found.add(candidates[0]);
    }
    for (const target of found) {
      referenceUncertainty.push({
        source,
        line: 0,
        kind: 'live-literal-reference-not-proven-invocation',
        expression: target,
        possibleTargets: [target],
        foldedIntoZeroReachability: false,
        evidence: 'A live root/reachable source names this zero-closure node, but the parser cannot prove a trusted invocation edge; fail-safe HOLD.',
      });
    }
  }
  unresolved = dedupe([...unresolved, ...referenceUncertainty]).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  const holds = new Map();
  const hold = (target, reason) => {
    if (!target || !analysisTrackedSet.has(target)) return;
    if (!holds.has(target)) holds.set(target, new Set());
    holds.get(target).add(reason);
  };
  for (const edge of suspects) {
    if (edge.disposition === 'works') continue;
    hold(edge.target, `suspect-edge:${edge.source}:${edge.line}:${edge.disposition}`);
    for (const target of edge.possibleTargets ?? []) {
      hold(target, `suspect-edge-possible-target:${edge.source}:${edge.line}:${edge.disposition}`);
    }
  }
  for (const row of unresolved) for (const target of row.possibleTargets ?? []) hold(target, `unresolved-dynamic:${row.source}:${row.line}`);
  for (const item of config.knownGood ?? []) hold(item, 'binding:known-good');

  const protectedTests = [...new Set([...KEEP_GUARD_TESTS, ...REWRITE_LIST_TESTS])].filter((item) => currentTrackedSet.has(item));
  for (const testPath of protectedTests) {
    hold(testPath, `binding:protected-test:${testPath}`);
    for (const ref of literalReferences.filter((item) => item.source === testPath)) hold(ref.target, `protected-test-reference:${testPath}`);
    for (const edge of trusted.filter((item) => item.source === testPath)) hold(edge.target, `protected-test-import:${testPath}`);
  }

  const heldNodes = [...holds.entries()].map(([file, reasons]) => ({ path: file, reasons: [...reasons].sort() })).sort((a, b) => a.path.localeCompare(b.path));
  const heldSet = new Set(heldNodes.map((item) => item.path));
  const zeroReachabilityCandidates = zeroReachabilityNodes.filter((item) => !heldSet.has(item));

  const supersededSurfaceInventory = deletionGraphNodes.map((node) => classifySupersededSurface(node, readSource(node), trusted.filter((edge) => edge.target === node))).filter(Boolean);
  const supersededCandidates = supersededSurfaceInventory.filter((row) => row.disposition === 'delete').map((row) => row.path);
  const backupCandidates = analysisTracked.filter((item) => BACKUP_PATTERN.test(item));
  const backupReferenceEvidence = backupCandidates.map((item) => ({
    path: item,
    sources: [...sourceMap.entries()]
      .filter(([source, text]) => source !== item && !source.startsWith('docs/declarations/') && text.includes(item))
      .map(([source]) => source)
      .sort(),
  }));
  const unsafeBackupCandidates = backupReferenceEvidence.filter((row) => row.sources.length > 0 || reachableSet.has(row.path) || heldSet.has(row.path)).map((row) => row.path);
  const deletableBackupCandidates = backupCandidates.filter((item) => !unsafeBackupCandidates.includes(item));
  const formulaCandidates = [...new Set([...zeroReachabilityCandidates, ...supersededCandidates, ...deletableBackupCandidates])].sort();

  const deletedGovernedNodes = deletedFromBase
    .filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item))
    .filter((item) => !externalPrerequisiteDeletionSet.has(item));
  const deletedTests = deletedFromBase.filter(isTestFile);
  const formulaSet = new Set(formulaCandidates);
  const deletionManifest = deletedGovernedNodes.map((item) => {
    const reason = deletableBackupCandidates.includes(item) ? 'backup'
      : supersededCandidates.includes(item) ? 'superseded'
        : zeroReachabilityCandidates.includes(item) ? 'zero-reachability'
          : 'unqualified';
    return {
      path: item,
      kind: 'file',
      reason,
      evidence: reason === 'backup'
        ? 'Tracked .pre-* or backup file in the pinned analysis base.'
        : reason === 'zero-reachability'
          ? 'Not reachable from any complete root through a trusted edge and not held by suspect/dynamic/protected evidence.'
          : reason === 'superseded'
            ? 'AO 0.10.2 superseded surface with no unresolved live caller.'
            : 'Deleted path does not satisfy the binding deadness formula.',
    };
  });

  const protectedExisting = {
    keepGuardList: KEEP_GUARD_TESTS.filter((item) => currentTrackedSet.has(item)),
    rewriteList: REWRITE_LIST_TESTS.filter((item) => currentTrackedSet.has(item)),
  };
  const externalPrerequisiteDeletions = ISSUE_821_EXTERNAL_DELETIONS.map((externalPath) => ({
    path: externalPath,
    issue: 821,
    trackedInBase: trackedSet.has(externalPath),
    deletedInCurrentTree: trackedSet.has(externalPath) && !currentTrackedSet.has(externalPath),
    evidence: 'Issue #821 owns this deletion; #819 retains the pinned-base node for audit but excludes it from its own deletion formula.',
  }));
  const retiredShimBlockers = REQUIRED_RETIRED_SHIMS.map((shim) => ({
    path: shim,
    trackedInBase: trackedSet.has(shim),
    deletedInCurrentTree: trackedSet.has(shim) && !currentTrackedSet.has(shim),
    reachable: reachableSet.has(shim),
    held: heldSet.has(shim),
    inboundTrustedEdges: trusted.filter((edge) => edge.target === shim),
    externalInboundTrustedEdges: trusted.filter((edge) => edge.target === shim && edge.source !== SCRIPT_REL && edge.source !== 'scripts/reachability-purge.test.ts'),
    protectedTestReferences: literalReferences.filter((ref) => ref.target === shim && protectedTests.includes(ref.source)),
  }));
  const migrationNotesEntry = manifestMigrationNote(repoRoot);
  const completionBlockers = [
    ...externalPrerequisiteDeletions
      .filter((row) => row.trackedInBase && !row.deletedInCurrentTree)
      .map((row) => ({
        code: 'external-prerequisite-deletion-incomplete',
        path: row.path,
        evidence: 'Issue #821 is the owner of this deletion, but the current tree still tracks the path.',
      })),
    // AC 9 (amended 2026-07-14): the shim cluster's live inbound edges make fail-safe KEEP the
    // required disposition, so only deleting a shim that still has live inbound trusted edges is
    // a violation.
    ...retiredShimBlockers
      .filter((row) => row.deletedInCurrentTree && row.externalInboundTrustedEdges.length > 0)
      .map((row) => ({
        code: 'shim-cluster-deleted-despite-live-inbound-edge',
        path: row.path,
        evidence: 'AC 9 (amended 2026-07-14): a node reached by a live inbound edge from a tracked consumer must be held (fail-safe KEEP), not deleted; the autonomous-surface shim cluster retirement is deferred to the sibling gate-predicate wave.',
      })),
    // AC 4's function/section caller-safety proof only applies when this PR actually deletes one.
    ...(deletionManifest.some((row) => row.reason === 'superseded') ? [{
      code: 'function-section-granularity-not-proven',
      path: SCRIPT_REL,
      evidence: 'The committed procedure proves whole-file deletion candidates only; the deletion set includes a superseded function/section entry whose caller-safety this procedure cannot yet prove.',
    }] : []),
  ];

  return {
    schemaVersion: 1,
    issue: ISSUE_NUMBER,
    generatedBy: SCRIPT_REL,
    analysisBase: { ref: baseRef, sha: baseSha },
    rootSet: roots,
    graphNodeCount: graphNodes.length,
    deletionGraphNodeCount: deletionGraphNodes.length,
    graphNodes,
    trustedEdges: trusted,
    suspectEdges: suspects,
    unresolvedDynamicForms: unresolved,
    reachableNodes,
    zeroReachabilityNodes,
    heldNodes,
    supersededSurfaceInventory,
    backupCandidates,
    backupReferenceEvidence,
    unsafeBackupCandidates,
    formulaCandidates,
    deletionManifest,
    deletionSetDiffFromFormula: {
      missing: formulaCandidates.filter((item) => currentTrackedSet.has(item)),
      unexpected: deletedGovernedNodes.filter((item) => !formulaSet.has(item)),
    },
    deletedTests,
    keepGuardList: protectedExisting.keepGuardList,
    rewriteList: protectedExisting.rewriteList,
    protectedTestsDeleted: deletedTests.filter((item) => protectedTests.includes(item)),
    externalPrerequisiteDeletions,
    retiredShimBlockers,
    migrationNotesEntry,
    completionStatus: completionBlockers.length === 0 ? 'complete' : 'blocked',
    completionBlockers,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value)}\n`;
}

async function main() {
  const repoRoot = repoRootFromScript();
  const args = new Set(process.argv.slice(2));
  const manifestPath = path.join(repoRoot, MANIFEST_REL);
  const manifest = await buildManifest(repoRoot);
  const serialized = stableJson(manifest);
  if (args.has('--write')) {
    writeFileSync(manifestPath, serialized, 'utf8');
    process.stdout.write(`wrote ${MANIFEST_REL}\n`);
    return;
  }
  if (args.has('--stdout')) {
    process.stdout.write(serialized);
    return;
  }
  if (!existsSync(manifestPath)) {
    process.stderr.write(`${MANIFEST_REL} is missing; run node ${SCRIPT_REL} --write\n`);
    process.exitCode = 1;
    return;
  }
  const committed = readFileSync(manifestPath, 'utf8');
  if (committed !== serialized) {
    process.stderr.write(`reachability manifest drift: run node ${SCRIPT_REL} --write and review the diff\n`);
    process.exitCode = 1;
    return;
  }
  if (manifest.deletionSetDiffFromFormula.missing.length > 0 || manifest.deletionSetDiffFromFormula.unexpected.length > 0) {
    process.stderr.write(`deletion-set formula mismatch: ${JSON.stringify(manifest.deletionSetDiffFromFormula)}\n`);
    process.exitCode = 1;
    return;
  }
  if (manifest.suspectEdges.some((item) => !item.disposition || !item.evidence)) {
    process.stderr.write('suspect-edge disposition incomplete\n');
    process.exitCode = 1;
    return;
  }
  if (manifest.suspectEdges.some((item) => !item.target && (!item.possibleTargets || item.possibleTargets.length === 0))) {
    process.stderr.write('dynamic suspect edge has no fail-closed possible-target hold\n');
    process.exitCode = 1;
    return;
  }
  if (manifest.unresolvedDynamicForms.some((item) => item.foldedIntoZeroReachability)) {
    process.stderr.write('unresolved dynamic invocation folded into zero reachability\n');
    process.exitCode = 1;
    return;
  }
  if (manifest.protectedTestsDeleted.length > 0) {
    process.stderr.write(`protected tests deleted: ${manifest.protectedTestsDeleted.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('reachability purge manifest: PASS\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
