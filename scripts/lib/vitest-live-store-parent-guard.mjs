import { existsSync, readdirSync, watch } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  assertHarnessWritePathSafe,
  canonicalizeStorePath,
  classifyLiveStorePath,
  expandInventoryTemplate,
  liveStoreInventory,
  resolvedClassFences,
  resolvedLiveStores,
  startLiveStoreGuard,
} from './vitest-live-store-harness.mjs';

const MAX_PARENT_WATCHERS = 512;
const POWERSHELL_PATH_PARAMETERS = new Set([
  'literalpath', 'path', 'filepath', 'statepath', 'storepath', 'journalpath',
  'watchpath', 'lockpath', 'statefile', 'clipath', 'auditroot', 'namespace',
  'stateroot', 'rootdir', 'storedir', 'directory', 'operatorinboxdir',
  'healthspooldir', 'clioverride', 'destination', 'reporoot', 'outputpath',
]);
const POWERSHELL_WRITE_PATTERN = /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Acl|WriteAllText|WriteAllBytes|AppendAllText|OpenWrite|Create|Replace)\b/i;

function pathIsSameOrWithin(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function nearestExistingDirectory(candidate) {
  let cursor = candidate;
  while (cursor && !existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return '';
    cursor = parent;
  }
  return cursor;
}

function transientFailureId(failure) {
  const suffix = ':transient_write_observed';
  return failure.endsWith(suffix) ? failure.slice(0, -suffix.length) : '';
}

function normalizePowerShellValue(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('`"', '"');
  }
  return text.replace(/[;,)}\]]+$/g, '');
}

function looksPathLike(value) {
  const text = normalizePowerShellValue(value);
  if (!text || text === '-' || text.startsWith('$')) return false;
  return text.startsWith('/')
    || text.startsWith('\\')
    || text.startsWith('~/')
    || text.startsWith('~\\')
    || /^[A-Za-z]:[\\/]/.test(text)
    || text.includes('/')
    || text.includes('\\');
}

function assertPowerShellCandidateSafe(value, operation, env) {
  const candidate = normalizePowerShellValue(value);
  if (!candidate || !looksPathLike(candidate)) return;
  assertHarnessWritePathSafe(candidate, operation, env);
}

function commandLiteralCandidates(command) {
  const values = [];
  for (const match of command.matchAll(/'((?:''|[^'])*)'/g)) values.push(match[1].replaceAll("''", "'"));
  for (const match of command.matchAll(/"((?:`"|[^"])*)"/g)) values.push(match[1].replaceAll('`"', '"'));
  for (const match of command.matchAll(/(?:^|[\s=(,;])((?:[A-Za-z]:[\\/]|~?[\\/])[^\s;|,)\]}]+)/g)) values.push(match[1]);
  return values;
}

export function preflightPowerShellInvocation(argv, env = process.env) {
  if (env.OPK_VITEST_HARNESS !== '1') return;

  for (const store of liveStoreInventory.stores ?? []) {
    if (store.excluded) continue;
    for (const envName of store.envOverrides ?? []) {
      const value = env[envName];
      if (String(value ?? '').trim()) assertHarnessWritePathSafe(value, `pwsh-env:${envName}`, env);
    }
  }

  const args = Array.from(argv ?? [], (value) => String(value));
  const lower = args.map((value) => value.toLowerCase());
  if (lower.some((value) => value === '-encodedcommand' || value === '-enc' || value === '-e')) {
    const error = new Error('OPK_VITEST_LIVE_STORE_BLOCKED encoded PowerShell commands are unsupported by the harness');
    error.code = 'OPK_VITEST_LIVE_STORE_BLOCKED';
    throw error;
  }

  const commandIndex = lower.findIndex((value) => value === '-command' || value === '-c');
  const fileIndex = lower.findIndex((value) => value === '-file' || value === '-f');
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const flag = token.match(/^--?([A-Za-z][A-Za-z0-9-]*)(?::(.*))?$/);
    if (!flag) {
      if (fileIndex >= 0 && index > fileIndex + 1) assertPowerShellCandidateSafe(token, 'pwsh-positional', env);
      continue;
    }
    const name = flag[1].toLowerCase();
    if (!POWERSHELL_PATH_PARAMETERS.has(name)) continue;
    const value = flag[2] !== undefined ? flag[2] : args[index + 1];
    if (value !== undefined) assertPowerShellCandidateSafe(value, `pwsh-arg:${name}`, env);
  }

  if (commandIndex >= 0) {
    const command = args.slice(commandIndex + 1).join(' ');
    if (POWERSHELL_WRITE_PATTERN.test(command)) {
      for (const candidate of commandLiteralCandidates(command)) {
        assertPowerShellCandidateSafe(candidate, 'pwsh-command-write', env);
      }
      for (const store of resolvedLiveStores(env)) {
        if (command.includes(store.defaultPath) || command.includes(basename(store.defaultPath))) {
          assertHarnessWritePathSafe(store.defaultPath, 'pwsh-command-write', env);
        }
      }
    }
  }
}

export function startParentLiveStoreGuard(env = process.env) {
  const baselineGuard = startLiveStoreGuard(env);
  const stores = resolvedLiveStores(env);
  const fences = resolvedClassFences(env);
  const roots = (liveStoreInventory.liveRoots ?? [])
    .filter((root) => root.watchTransient !== false)
    .map((root) => canonicalizeStorePath(expandInventoryTemplate(root.defaultTemplate, env)))
    .filter(Boolean);
  const targets = new Set([
    ...stores.map((store) => (store.kind === 'pattern' ? store.defaultPath : store.parentPath)),
    ...fences.filter((fence) => fence.watchTransient !== false).map((fence) => fence.rootPath),
    ...roots,
  ]);
  const exactTouches = new Set();
  const watchers = [];
  const watched = new Set();

  const armTree = (root) => {
    const anchor = nearestExistingDirectory(root);
    if (!anchor || watched.has(anchor) || watched.size >= MAX_PARENT_WATCHERS) return;
    watched.add(anchor);
    try {
      const handle = watch(anchor, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const candidate = canonicalizeStorePath(join(anchor, String(filename)));
        const match = classifyLiveStorePath(candidate, env);
        if (match) exactTouches.add(match.storeId);

        if (existsSync(candidate)) {
          armTree(candidate);
          try {
            for (const entry of readdirSync(candidate, { withFileTypes: true })) {
              if (entry.isDirectory()) armTree(join(candidate, entry.name));
            }
          } catch {
            // A concurrent delete is still covered by the event already observed.
          }
        }
        for (const target of targets) {
          if (candidate && pathIsSameOrWithin(target, candidate)) armTree(target);
        }
      });
      watchers.push(handle);
    } catch {
      // The baseline hash guard remains authoritative when watch is unavailable.
    }
  };

  for (const target of targets) armTree(target);

  return {
    stop() {
      for (const handle of watchers) handle.close();
      let baselineFailures = [];
      try {
        baselineGuard.stop();
      } catch (error) {
        if (error?.code !== 'OPK_VITEST_LIVE_STORE_GUARD_FAILED') throw error;
        baselineFailures = Array.isArray(error.failures) ? [...error.failures] : [];
      }

      const retained = baselineFailures.filter((failure) => {
        const id = transientFailureId(String(failure));
        return !id || exactTouches.has(id);
      });
      for (const id of exactTouches) {
        const failure = `${id}:transient_write_observed`;
        if (!retained.includes(failure)) retained.push(failure);
      }
      if (retained.length > 0) {
        const error = new Error(`OPK_VITEST_LIVE_STORE_GUARD_FAILED ${retained.join(',')}`);
        error.code = 'OPK_VITEST_LIVE_STORE_GUARD_FAILED';
        error.failures = retained;
        throw error;
      }
    },
  };
}
