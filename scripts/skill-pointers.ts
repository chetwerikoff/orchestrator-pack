import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface SkillPointerTarget {
  readonly root: string;
  readonly canonicalLinkPrefix: string;
}

export interface SkillPointerConfig {
  readonly canonicalRoot: string;
  readonly targets: readonly SkillPointerTarget[];
  readonly implementationSupport: readonly string[];
}

export const DEFAULT_SKILL_POINTER_CONFIG = 'scripts/skill-pointer-targets.json';
export const RETIRED_OPENCODE_SKILL = 'opencode-merge-and-pull';

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function requireRelativeRoot(value: unknown, label: string): string {
  const normalized = normalizePath(String(value ?? '').trim());
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

function requireImplementationSupport(
  value: unknown,
  targets: readonly SkillPointerTarget[],
  canonicalRoot: string,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('implementationSupport must be an array');
  const support = value.map((candidate, index) => requireRelativeRoot(candidate, `implementationSupport[${index}]`));
  if (new Set(support).size !== support.length) throw new Error('implementationSupport paths must be unique');
  for (const path of support) {
    if (path.endsWith('/SKILL.md')) throw new Error(`implementation support cannot be a procedure: ${path}`);
    if (path === canonicalRoot || path.startsWith(`${canonicalRoot}/`)) {
      throw new Error(`implementation support cannot live under canonicalRoot: ${path}`);
    }
    if (!targets.some((target) => path.startsWith(`${target.root}/`))) {
      throw new Error(`implementation support must live under a pointer target root: ${path}`);
    }
  }
  return support.sort();
}

export function readSkillPointerConfig(repoRoot: string, configPath = DEFAULT_SKILL_POINTER_CONFIG): SkillPointerConfig {
  const parsed = JSON.parse(readFileSync(resolve(repoRoot, configPath), 'utf8')) as Record<string, unknown>;
  const canonicalRoot = requireRelativeRoot(parsed.canonicalRoot, 'canonicalRoot');
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) throw new Error('skill-pointer targets must be a non-empty array');
  const targets = parsed.targets.map((candidate, index): SkillPointerTarget => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`skill-pointer target ${index} must be an object`);
    const record = candidate as Record<string, unknown>;
    const root = requireRelativeRoot(record.root, `targets[${index}].root`);
    const canonicalLinkPrefix = String(record.canonicalLinkPrefix ?? '').trim().replaceAll('\\', '/').replace(/\/$/u, '');
    if (!canonicalLinkPrefix || !canonicalLinkPrefix.startsWith('../')) throw new Error(`targets[${index}].canonicalLinkPrefix must be relative`);
    if (root === canonicalRoot) throw new Error('canonicalRoot cannot also be a pointer target');
    return { root, canonicalLinkPrefix };
  });
  const implementationSupport = requireImplementationSupport(parsed.implementationSupport, targets, canonicalRoot);
  return { canonicalRoot, targets, implementationSupport };
}

interface SkillFrontmatter {
  readonly block: string;
  readonly name: string;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = /^(---\r?\n[\s\S]*?\r?\n---)(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error('SKILL.md missing YAML frontmatter delimiters (---)');
  const block = match[1]!;
  const nameMatch = /^name:\s*(.+?)\s*$/mu.exec(block);
  if (!nameMatch) throw new Error('SKILL frontmatter missing required name');
  if (!/^description:/mu.test(block)) throw new Error(`SKILL frontmatter for '${nameMatch[1]!.trim()}' missing required description`);
  const name = nameMatch[1]!.trim().replace(/^['"]|['"]$/gu, '');
  if (!name) throw new Error('SKILL frontmatter name must be non-empty');
  return { block, name };
}

function canonicalSkillNames(repoRoot: string, canonicalRoot: string): string[] {
  const root = resolve(repoRoot, canonicalRoot);
  if (!existsSync(root)) throw new Error(`Canonical skills root not found: ${canonicalRoot}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function pointerBody(config: SkillPointerConfig, target: SkillPointerTarget, skillName: string): string {
  return `Read and execute [\`${config.canonicalRoot}/${skillName}/SKILL.md\`](${target.canonicalLinkPrefix}/${skillName}/SKILL.md) in full. Do not re-derive the workflow inline.`;
}

export function expectedSkillPointerMap(repoRoot: string, config: SkillPointerConfig): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const skillName of canonicalSkillNames(repoRoot, config.canonicalRoot)) {
    const canonicalPath = resolve(repoRoot, config.canonicalRoot, skillName, 'SKILL.md');
    const content = readFileSync(canonicalPath, 'utf8');
    const frontmatter = parseSkillFrontmatter(content);
    if (frontmatter.name !== skillName) throw new Error(`canonical skill name mismatch: ${skillName} != ${frontmatter.name}`);
    for (const target of config.targets) {
      const path = `${target.root}/${skillName}/SKILL.md`;
      result.set(path, `${frontmatter.block}\n\n${pointerBody(config, target, skillName)}\n`);
    }
  }
  return result;
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(normalizePath(relative(root, full)));
    }
  };
  visit(root);
  return files.sort();
}

function supportForSkill(config: SkillPointerConfig, target: SkillPointerTarget, skillName: string): string[] {
  const prefix = `${target.root}/${skillName}/`;
  return config.implementationSupport
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .sort();
}

export function evaluateSkillPointerDrift(repoRoot: string, configPath = DEFAULT_SKILL_POINTER_CONFIG): readonly string[] {
  const config = readSkillPointerConfig(repoRoot, configPath);
  const failures: string[] = [];
  const canonicalNames = canonicalSkillNames(repoRoot, config.canonicalRoot);
  if (canonicalNames.includes(RETIRED_OPENCODE_SKILL)) failures.push(`retired skill reappeared: ${config.canonicalRoot}/${RETIRED_OPENCODE_SKILL}`);
  const expected = expectedSkillPointerMap(repoRoot, config);

  for (const skillName of canonicalNames) {
    const canonicalPath = resolve(repoRoot, config.canonicalRoot, skillName, 'SKILL.md');
    const canonical = readFileSync(canonicalPath, 'utf8');
    for (const target of config.targets) {
      const reversePointer = `Read and execute [\`${target.root}/${skillName}/SKILL.md\`]`;
      if (canonical.includes(reversePointer)) failures.push(`reverse pointer in canonical skill: ${config.canonicalRoot}/${skillName}/SKILL.md`);
    }
  }

  for (const supportPath of config.implementationSupport) {
    if (!existsSync(resolve(repoRoot, supportPath))) failures.push(`missing implementation support: ${supportPath}`);
    for (const target of config.targets) {
      const prefix = `${target.root}/`;
      if (!supportPath.startsWith(prefix)) continue;
      const canonicalTwin = `${config.canonicalRoot}/${supportPath.slice(prefix.length)}`;
      if (existsSync(resolve(repoRoot, canonicalTwin))) failures.push(`implementation support duplicated under canonical root: ${canonicalTwin}`);
    }
  }

  for (const target of config.targets) {
    const targetRoot = resolve(repoRoot, target.root);
    if (!existsSync(targetRoot)) {
      failures.push(`pointer target root missing: ${target.root}`);
      continue;
    }
    const targetNames = readdirSync(targetRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    if (targetNames.includes(RETIRED_OPENCODE_SKILL)) failures.push(`retired skill reappeared: ${target.root}/${RETIRED_OPENCODE_SKILL}`);
    for (const name of targetNames) {
      const skillFile = resolve(repoRoot, target.root, name, 'SKILL.md');
      if (existsSync(skillFile) && !canonicalNames.includes(name)) failures.push(`orphan pointer without canonical skill: ${target.root}/${name}/SKILL.md`);
    }
    for (const skillName of canonicalNames) {
      const relativeSkill = `${target.root}/${skillName}/SKILL.md`;
      const expectedContent = expected.get(relativeSkill)!;
      const full = resolve(repoRoot, relativeSkill);
      if (!existsSync(full)) {
        failures.push(`missing pointer: ${relativeSkill}`);
        continue;
      }
      const actual = readFileSync(full, 'utf8');
      if (actual !== expectedContent) failures.push(`pointer drift: ${relativeSkill}`);
      const files = listFiles(resolve(repoRoot, target.root, skillName));
      const allowedFiles = ['SKILL.md', ...supportForSkill(config, target, skillName)].sort();
      const unexpected = files.filter((file) => !allowedFiles.includes(file));
      const missingSupport = allowedFiles.filter((file) => file !== 'SKILL.md' && !files.includes(file));
      if (unexpected.length > 0) failures.push(`pointer skill contains unclassified files: ${target.root}/${skillName}: ${unexpected.join(', ')}`);
      if (missingSupport.length > 0) failures.push(`pointer skill missing classified implementation support: ${target.root}/${skillName}: ${missingSupport.join(', ')}`);
    }
  }
  return failures.sort();
}

export function writeSkillPointers(repoRoot: string, configPath = DEFAULT_SKILL_POINTER_CONFIG): number {
  const config = readSkillPointerConfig(repoRoot, configPath);
  const expected = expectedSkillPointerMap(repoRoot, config);
  const canonicalNames = new Set(canonicalSkillNames(repoRoot, config.canonicalRoot));
  for (const target of config.targets) {
    const root = resolve(repoRoot, target.root);
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || canonicalNames.has(entry.name)) continue;
      rmSync(join(root, entry.name, 'SKILL.md'), { force: true });
    }
  }
  for (const [path, content] of expected) {
    const full = resolve(repoRoot, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return expected.size;
}
