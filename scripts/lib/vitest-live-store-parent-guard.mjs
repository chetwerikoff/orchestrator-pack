import { existsSync, readdirSync, watch } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  'healthspooldir', 'clioverride', 'destination', 'newname', 'reporoot', 'outputpath',
]);
const POWERSHELL_WRITE_CMDLETS = [
  'Set-Content', 'Add-Content', 'Out-File', 'Clear-Content', 'New-Item',
  'Remove-Item', 'Move-Item', 'Copy-Item', 'Rename-Item', 'Set-Acl',
];
const POWERSHELL_DOTNET_WRITE_METHODS = new Map([
  ['WriteAllText', 1],
  ['WriteAllBytes', 1],
  ['AppendAllText', 1],
  ['OpenWrite', 1],
  ['Create', 1],
  ['CreateText', 1],
  ['AppendText', 1],
  ['CreateDirectory', 1],
  ['Delete', 1],
  ['Copy', 2],
  ['Move', 2],
  ['Replace', 3],
]);
const POWERSHELL_VALUE_TOKEN = String.raw`(?:'(?:''|[^'])*'|"(?:\`"|[^"])*"|[^\s;|,)]+)`;

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitPowerShellStatements(command) {
  const statements = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (quote === "'") {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        quote = '';
      }
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '`' && next !== undefined) {
        current += next;
        index += 1;
      } else if (char === '"') {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '\n' || char === '\r') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function splitPowerShellArguments(value) {
  const args = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (quote === "'") {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        quote = '';
      }
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '`' && next !== undefined) {
        current += next;
        index += 1;
      } else if (char === '"') {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function inventoryPowerShellCommands() {
  const resolvers = new Set();
  const writers = new Set(POWERSHELL_WRITE_CMDLETS);
  for (const store of liveStoreInventory.stores ?? []) {
    for (const name of [store.resolver, ...(store.resolverAliases ?? [])]) {
      if (/^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/.test(String(name ?? ''))) {
        resolvers.add(String(name));
      }
    }
    for (const match of String(store.writeBoundary ?? '').matchAll(/\b[A-Z][A-Za-z0-9]*(?:-[A-Z][A-Za-z0-9]*)+\b/g)) {
      writers.add(match[0]);
    }
  }
  return { resolvers, writers };
}

const POWERSHELL_INVENTORY_COMMANDS = inventoryPowerShellCommands();
const POWERSHELL_ENV_OVERRIDES = [...new Set(
  (liveStoreInventory.stores ?? [])
    .filter((store) => !store.excluded)
    .flatMap((store) => store.envOverrides ?? [])
    .map((name) => String(name))
    .filter(Boolean),
)].sort();
const VALIDATED_POWERSHELL_ENVIRONMENTS = new Set();
const MAX_VALIDATED_POWERSHELL_ENVIRONMENTS = 64;

function statementHasCommand(statement, commands) {
  for (const command of commands) {
    if (new RegExp(`\\b${escapeRegExp(command)}\\b`, 'i').test(statement)) return true;
  }
  return false;
}

function namedPathCandidates(statement) {
  const names = [...POWERSHELL_PATH_PARAMETERS].map(escapeRegExp).join('|');
  const pattern = new RegExp(`-(?:${names})(?:\\s+|:)(${POWERSHELL_VALUE_TOKEN})`, 'gi');
  return [...statement.matchAll(pattern)].map((match) => match[1]);
}

function firstPositionalCandidate(statement, commandName) {
  const commandPattern = new RegExp(`\\b${escapeRegExp(commandName)}\\b`, 'i');
  const match = commandPattern.exec(statement);
  if (!match) return '';
  const tail = statement.slice(match.index + match[0].length).trim();
  if (!tail || tail.startsWith('-')) return '';
  const value = new RegExp(`^(${POWERSHELL_VALUE_TOKEN})`, 'i').exec(tail)?.[1] ?? '';
  return value;
}

function dotNetWriteCandidates(statement) {
  const candidates = [];
  const methods = [...POWERSHELL_DOTNET_WRITE_METHODS.keys()].map(escapeRegExp).join('|');
  const methodPattern = new RegExp(`::(${methods})\\s*\\(([^)]*)\\)`, 'gi');
  for (const match of statement.matchAll(methodPattern)) {
    const count = POWERSHELL_DOTNET_WRITE_METHODS.get(match[1]) ?? 0;
    candidates.push(...splitPowerShellArguments(match[2]).slice(0, count));
  }
  return candidates;
}

function commandWriteCandidates(command) {
  const candidates = [];
  for (const statement of splitPowerShellStatements(command)) {
    const isResolver = statementHasCommand(statement, POWERSHELL_INVENTORY_COMMANDS.resolvers);
    const isWriter = statementHasCommand(statement, POWERSHELL_INVENTORY_COMMANDS.writers);
    const dotNetCandidates = dotNetWriteCandidates(statement);
    if (!isResolver && !isWriter && dotNetCandidates.length === 0) continue;
    const namedCandidates = namedPathCandidates(statement);
    candidates.push(...namedCandidates, ...dotNetCandidates);
    if (isWriter && namedCandidates.length === 0) {
      for (const commandName of POWERSHELL_WRITE_CMDLETS) {
        const positional = firstPositionalCandidate(statement, commandName);
        if (positional) candidates.push(positional);
      }
    }
  }
  return candidates;
}

export function validatePowerShellHarnessEnvironment(env = process.env) {
  if (env.OPK_VITEST_HARNESS !== '1') return;

  const harnessRootValue = String(env.OPK_VITEST_HARNESS_ROOT ?? '').trim();
  const fingerprint = JSON.stringify([
    harnessRootValue,
    String(env.OPK_VITEST_PRODUCTION_HOME ?? ''),
    String(env.OPK_VITEST_PRODUCTION_TMP ?? ''),
    String(env.OPK_VITEST_PRODUCTION_AO_BASE ?? ''),
    String(env.OPK_VITEST_PRODUCTION_WAKE_ROOT ?? ''),
    ...POWERSHELL_ENV_OVERRIDES.map((name) => [name, String(env[name] ?? '')]),
  ]);
  if (VALIDATED_POWERSHELL_ENVIRONMENTS.has(fingerprint)) return;

  const harnessRoot = harnessRootValue ? resolve(harnessRootValue) : '';
  const checkedValues = new Set();
  for (const envName of POWERSHELL_ENV_OVERRIDES) {
    const value = String(env[envName] ?? '').trim();
    if (!value || checkedValues.has(value)) continue;
    checkedValues.add(value);

    // Harness-owned overrides are constructed below the invocation root. Avoid
    // resolving the complete production catalog for every child PowerShell
    // process; the parent guard and bootstrap have already frozen that root.
    const candidate = resolve(value);
    if (harnessRoot && pathIsSameOrWithin(candidate, harnessRoot)) continue;
    assertHarnessWritePathSafe(value, `pwsh-env:${envName}`, env);
  }

  if (VALIDATED_POWERSHELL_ENVIRONMENTS.size >= MAX_VALIDATED_POWERSHELL_ENVIRONMENTS) {
    VALIDATED_POWERSHELL_ENVIRONMENTS.clear();
  }
  VALIDATED_POWERSHELL_ENVIRONMENTS.add(fingerprint);
}

export function preflightPowerShellInvocation(argv, env = process.env) {
  if (env.OPK_VITEST_HARNESS !== '1') return;
  validatePowerShellHarnessEnvironment(env);

  const args = Array.from(argv ?? [], (value) => String(value));
  const lower = args.map((value) => value.toLowerCase());
  if (lower.some((value) => value === '-encodedcommand' || value === '-enc' || value === '-e')) {
    const error = new Error('OPK_VITEST_LIVE_STORE_BLOCKED encoded PowerShell commands are unsupported by the harness');
    error.code = 'OPK_VITEST_LIVE_STORE_BLOCKED';
    throw error;
  }

  const commandIndex = lower.findIndex((value) => value === '-command' || value === '-c');
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const flag = token.match(/^--?([A-Za-z][A-Za-z0-9-]*)(?::(.*))?$/);
    if (!flag) continue;
    const name = flag[1].toLowerCase();
    if (!POWERSHELL_PATH_PARAMETERS.has(name)) continue;
    const value = flag[2] !== undefined ? flag[2] : args[index + 1];
    if (value !== undefined) assertPowerShellCandidateSafe(value, `pwsh-arg:${name}`, env);
  }

  if (commandIndex >= 0) {
    const command = args.slice(commandIndex + 1).join(' ');
    for (const candidate of commandWriteCandidates(command)) {
      assertPowerShellCandidateSafe(candidate, 'pwsh-command-write', env);
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
