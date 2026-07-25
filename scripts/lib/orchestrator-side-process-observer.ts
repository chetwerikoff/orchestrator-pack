import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ObserverRecord = Record<string, unknown>;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const REGISTRY_PATH = join(REPO_ROOT, 'scripts', 'orchestrator-side-process-registry.json');

function record(value: unknown): ObserverRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObserverRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function normalizeObservedPath(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return '';
  try {
    return normalize(realpathSync(candidate));
  } catch {
    return normalize(isAbsolute(candidate) ? candidate : resolve(candidate));
  }
}

function registryDocument(): ObserverRecord {
  const parsed: unknown = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const doc = record(parsed);
  if (!Array.isArray(doc.children)) throw new Error('side_process_registry_children_missing');
  return doc;
}

export function childRegistry(): ObserverRecord[] {
  return array(registryDocument().children).map((raw) => {
    const child = record(raw);
    const script = text(child.script);
    return {
      Id: text(child.id),
      ScriptPath: join(REPO_ROOT, 'scripts', script),
      ScriptMarker: script,
      SideEffecting: child.sideEffecting === true,
      SideEffectLockFile: text(child.sideEffectLockFile),
      RequiresOrchestratorSession: child.requiresOrchestratorSession === true,
      PassProjectId: child.passProjectId === true,
      CadenceSeconds: Number(child.cadenceSeconds ?? 0),
      StallGraceMultiplier: Number(child.stallGraceMultiplier ?? 0),
      ExtraArgs: array(child.extraArgs).map(text),
    };
  });
}

export function childEntry(id: unknown): ObserverRecord | null {
  const expected = text(id);
  return childRegistry().find((entry) => text(entry.Id) === expected) ?? null;
}

export function supervisorPaths(stateRootValue: unknown): ObserverRecord {
  const root = text(stateRootValue);
  const paths: ObserverRecord = {
    Root: root,
    SupervisorPid: join(root, 'supervisor.pid'),
    SupervisorLock: join(root, 'supervisor.lock'),
    StateJson: join(root, 'state.json'),
    SupervisorLog: join(root, 'supervisor.log'),
    ProgressDir: join(root, 'progress'),
    StoppingFlag: join(root, 'stopping'),
  };
  for (const child of childRegistry()) {
    const id = text(child.Id);
    paths[`${id}Pid`] = join(root, `${id}.pid`);
    paths[`${id}Log`] = join(root, `${id}.log`);
    const lock = text(child.SideEffectLockFile);
    if (lock) paths[`${id}Lock`] = join(root, lock);
  }
  return paths;
}

export function switchValue(tokensValue: unknown, switchNameValue: unknown): string | null {
  const tokens = array(tokensValue).map(text);
  const switchName = text(switchNameValue);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === switchName) {
      const next = tokens[index + 1] ?? '';
      return next && !next.startsWith('-') ? next : 'true';
    }
    if (token.startsWith(`${switchName}=`) && token.length > switchName.length + 1) {
      return token.slice(switchName.length + 1);
    }
  }
  return null;
}

export function commandLineScriptPath(tokensValue: unknown): string {
  const tokens = array(tokensValue).map(text);
  for (let index = 0; index < tokens.length; index += 1) {
    if ((tokens[index] === '-File' || tokens[index] === '-f') && tokens[index + 1]) return tokens[index + 1] ?? '';
  }
  return '';
}

export function supervisorCommandIdentity(payload: ObserverRecord): boolean {
  const tokens = array(payload.tokens ?? payload.Tokens).map(text);
  const commandLine = text(payload.commandLine ?? payload.CommandLine);
  const actualTokens = tokens.length ? tokens : commandLine.split(/\s+/).filter(Boolean);
  const scriptPath = normalizeObservedPath(commandLineScriptPath(actualTokens));
  const expectedScript = normalizeObservedPath(join(REPO_ROOT, 'scripts', 'orchestrator-wake-supervisor.ps1'));
  if (!scriptPath || scriptPath !== expectedScript) return false;
  const expectedProject = text(payload.projectId ?? payload.ProjectId) || 'orchestrator-pack';
  const project = switchValue(actualTokens, '-ProjectId');
  if (project && project !== 'true' && project !== expectedProject) return false;
  const expectedState = normalizeObservedPath(payload.stateRoot ?? payload.StateRoot);
  const state = switchValue(actualTokens, '-StateDir');
  if (expectedState && state && state !== 'true' && normalizeObservedPath(state) !== expectedState) return false;
  return true;
}

export function readPidFile(pathValue: unknown): number {
  const path = text(pathValue);
  if (!path) return 0;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return 0;
    try {
      const parsed = record(JSON.parse(raw));
      const pid = Number(parsed.pid ?? parsed.Pid ?? 0);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch {
      const pid = Number(raw.split(/\r?\n/, 1)[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    }
  } catch {
    return 0;
  }
}

export function dispatchObserverOperation(operation: string, payload: ObserverRecord): unknown {
  switch (operation) {
    case 'registry': return childRegistry();
    case 'child-entry': return childEntry(payload.childId ?? payload.ChildId);
    case 'paths': return supervisorPaths(payload.stateRoot ?? payload.StateRoot);
    case 'normalize-path': return normalizeObservedPath(payload.pathValue ?? payload.PathValue);
    case 'switch-value': return switchValue(payload.tokens ?? payload.Tokens, payload.switchName ?? payload.SwitchName);
    case 'has-switch': return switchValue(payload.tokens ?? payload.Tokens, payload.switchName ?? payload.SwitchName) !== null;
    case 'script-path': return commandLineScriptPath(payload.tokens ?? payload.Tokens);
    case 'supervisor-command-identity': return supervisorCommandIdentity(payload);
    case 'read-pid': return readPidFile(payload.path ?? payload.Path);
    case 'default-project-id': return text(process.env.AO_WAKE_SUPERVISOR_PROJECT_ID) || 'orchestrator-pack';
    default: throw new Error(`unsupported_side_process_observer_operation:${operation}`);
  }
}
