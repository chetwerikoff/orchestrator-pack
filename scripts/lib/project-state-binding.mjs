import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROJECT_STATE_BINDING_FILE = 'project-binding.json';
export const PROJECT_STATE_BINDING_SCHEMA = 'orchestrator-pack/project-state-binding/v1';

function normalizedExpected(input) {
  const projectId = String(input?.projectId ?? '').trim();
  const repository = String(input?.repository ?? '').trim().toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) throw new Error('project_state_binding_project_invalid');
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('project_state_binding_repository_invalid');
  return {
    schema: PROJECT_STATE_BINDING_SCHEMA,
    projectId,
    repository,
  };
}

function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableJson(target, value) {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${PROJECT_STATE_BINDING_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  syncDirectory(directory);
}

export function projectStateBindingPath(namespaceRoot) {
  return join(resolve(namespaceRoot), PROJECT_STATE_BINDING_FILE);
}

export function readProjectStateBinding(namespaceRoot) {
  const file = projectStateBindingPath(namespaceRoot);
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('project_state_binding_unreadable');
  }
  const expectedKeys = ['projectId', 'repository', 'schema'];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.schema !== PROJECT_STATE_BINDING_SCHEMA
  ) throw new Error('project_state_binding_invalid');
  return normalizedExpected(value);
}

export function assertProjectStateBinding(namespaceRoot, expectedInput) {
  const expected = normalizedExpected(expectedInput);
  const observed = readProjectStateBinding(namespaceRoot);
  if (!observed) throw new Error('project_state_binding_missing');
  if (observed.projectId !== expected.projectId || observed.repository !== expected.repository) {
    throw new Error('project_state_binding_mismatch');
  }
  return observed;
}

function namespacePayloadEntries(namespaceRoot) {
  if (!existsSync(namespaceRoot)) return [];
  return readdirSync(namespaceRoot).filter((name) => name !== PROJECT_STATE_BINDING_FILE);
}

export function ensureProjectStateBinding(namespaceRoot, expectedInput) {
  const expected = normalizedExpected(expectedInput);
  const observed = readProjectStateBinding(namespaceRoot);
  if (observed) {
    if (observed.projectId !== expected.projectId || observed.repository !== expected.repository) {
      throw new Error('project_state_binding_mismatch');
    }
    return observed;
  }
  if (namespacePayloadEntries(namespaceRoot).length !== 0) {
    throw new Error('project_state_binding_missing_for_nonempty_namespace');
  }
  durableJson(projectStateBindingPath(namespaceRoot), expected);
  return assertProjectStateBinding(namespaceRoot, expected);
}

/**
 * Called only after the existing cutover epoch CAS is durably committed.
 * A non-empty namespace can be bound here because the commit already made its
 * imported destination authoritative. Replays are idempotent.
 */
export function publishCommittedProjectStateBinding(namespaceRoot, expectedInput) {
  const expected = normalizedExpected(expectedInput);
  const observed = readProjectStateBinding(namespaceRoot);
  if (observed) {
    if (observed.projectId !== expected.projectId || observed.repository !== expected.repository) {
      throw new Error('project_state_binding_mismatch');
    }
    return observed;
  }
  durableJson(projectStateBindingPath(namespaceRoot), expected);
  return assertProjectStateBinding(namespaceRoot, expected);
}

export function removeProjectStateBindingIfEmpty(namespaceRoot) {
  if (namespacePayloadEntries(namespaceRoot).length !== 0) return false;
  rmSync(projectStateBindingPath(namespaceRoot), { force: true });
  return true;
}
