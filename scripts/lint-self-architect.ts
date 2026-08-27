#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';

type Suppression = { rule?: string; files?: string[] };
type Config = {
  scanPaths: string[];
  excludePaths: string[];
  scriptExtensions: string[];
  templateExtensions: string[];
  duplicateLiteralMinLines: number;
  pairedEditMinLines: number;
  pairedLineStride: number;
  heuristicMinLines: number;
  heuristicMaxLines: number;
  similarityThreshold: number;
  heuristicLineStride: number;
  heuristicMaxFindings: number;
  heuristicMaxFileLines: number;
  pairedOverlapMinLines: number;
  pairedOverlapMinRatio: number;
  suppressions: Suppression[];
};
type Location = { file: string; startLine: number; endLine: number };
type Finding = { rule: string; severity: 'strict' | 'warning'; rationale: string; locations: Location[] };
type Options = {
  strict: boolean;
  baseRef: string;
  headRef: string;
  configPath: string;
  repoRoot: string;
  withWorkingTree: boolean;
  fixtureRoot: string;
};

const DEFAULT_CONFIG: Config = {
  scanPaths: ['prompts/**', 'scripts/**', 'plugins/**', 'docs/**', '.github/**'],
  excludePaths: ['tests/fixtures/**', 'vendor/**', 'packages/core/**', '.orchestrator-pack/**', 'node_modules/**'],
  scriptExtensions: ['.ps1', '.sh', '.bash', '.js', '.ts', '.mjs', '.cjs'],
  templateExtensions: ['.md', '.yaml', '.yml', '.json', '.example', '.template', '.tpl'],
  duplicateLiteralMinLines: 10,
  pairedEditMinLines: 8,
  pairedLineStride: 2,
  heuristicMinLines: 3,
  heuristicMaxLines: 9,
  similarityThreshold: 0.85,
  heuristicLineStride: 3,
  heuristicMaxFindings: 25,
  heuristicMaxFileLines: 300,
  pairedOverlapMinLines: 6,
  pairedOverlapMinRatio: 0.75,
  suppressions: [],
};

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.?\//u, '');
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '*' && normalized[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '.';
    } else if ('\\.^$+{}()|[]'.includes(char)) {
      source += '\\' + char;
    } else {
      source += char;
    }
  }
  return new RegExp('^' + source + '$', 'u');
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => {
    const glob = normalizePath(pattern);
    if (!/[*?[\]]/u.test(glob)) return normalized === glob || normalized.startsWith(glob + '/');
    return globRegex(glob).test(normalized);
  });
}

function shouldScan(path: string, config: Config): boolean {
  if (matchesAny(path, config.excludePaths)) return false;
  return config.scanPaths.length === 0 || matchesAny(path, config.scanPaths);
}

function readConfig(path: string): Config {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, suppressions: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    scanPaths: parsed.scanPaths ?? DEFAULT_CONFIG.scanPaths,
    excludePaths: parsed.excludePaths ?? DEFAULT_CONFIG.excludePaths,
    scriptExtensions: parsed.scriptExtensions ?? DEFAULT_CONFIG.scriptExtensions,
    templateExtensions: parsed.templateExtensions ?? DEFAULT_CONFIG.templateExtensions,
    suppressions: parsed.suppressions ?? [],
  };
}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcessSync({
    command: 'git',
    args: ['-C', root, ...args],
    cwd: root,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
  return {
    ok: result.ok,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function gitLines(root: string, args: string[]): string[] {
  const result = git(root, args);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function changedPaths(root: string, baseRef: string, headRef: string, withWorkingTree: boolean): string[] {
  const out = new Set<string>();
  if (baseRef) {
    let result = git(root, ['diff', '--name-only', baseRef + '...' + headRef]);
    if (!result.ok) result = git(root, ['diff', '--name-only', baseRef, headRef]);
    if (!result.ok) return [];
    for (const line of result.stdout.split(/\r?\n/u)) if (line.trim()) out.add(normalizePath(line.trim()));
    return [...out];
  }
  for (const path of gitLines(root, ['diff', '--cached', '--name-only'])) out.add(normalizePath(path));
  if (withWorkingTree) {
    for (const path of gitLines(root, ['diff', '--name-only'])) out.add(normalizePath(path));
    for (const path of gitLines(root, ['ls-files', '--others', '--exclude-standard'])) out.add(normalizePath(path));
  }
  return [...out];
}

function fixtureFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out.push(normalizePath(relative(root, full)));
    }
  };
  walk(root);
  return out;
}

function textLines(fullPath: string): string[] {
  if (!existsSync(fullPath)) return [];
  return readFileSync(fullPath, 'utf8').split(/\r?\n/u).map((line) => line.trimEnd());
}

function blocks(lines: readonly string[], size: number): Array<{ text: string; startLine: number; endLine: number }> {
  const out: Array<{ text: string; startLine: number; endLine: number }> = [];
  if (size <= 0 || lines.length < size) return out;
  for (let start = 0; start <= lines.length - size; start += 1) {
    const slice = lines.slice(start, start + size);
    if (!slice.some((line) => /\S/u.test(line))) continue;
    out.push({ text: slice.join('\n'), startLine: start + 1, endLine: start + size });
  }
  return out;
}

function suppressed(config: Config, rule: string, files: readonly string[]): boolean {
  const wanted = [...files].map(normalizePath).sort();
  return config.suppressions.some((entry) => {
    if (entry.rule && entry.rule !== rule) return false;
    const candidate = (entry.files ?? []).map(normalizePath).sort();
    return candidate.length === wanted.length && candidate.every((value, index) => value === wanted[index]);
  });
}

function renameMap(root: string, baseRef: string, headRef: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!baseRef) return map;
  let result = git(root, ['diff', '--name-status', '-M', baseRef + '...' + headRef]);
  if (!result.ok) result = git(root, ['diff', '--name-status', '-M', baseRef, headRef]);
  if (!result.ok) return map;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const parts = line.split('\t');
    if (parts.length >= 3 && /^R\d+$/u.test(parts[0] ?? '')) {
      map.set(normalizePath(parts[2]!).toLowerCase(), normalizePath(parts[1]!));
    }
  }
  return map;
}

function baseLines(root: string, baseRef: string, path: string): string[] {
  const result = git(root, ['show', baseRef + ':' + path]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trimEnd());
}

function duplicateFindings(
  files: Map<string, string[]>,
  introducedPaths: readonly string[],
  config: Config,
  root: string,
  baseRef: string,
  headRef: string,
): Finding[] {
  const size = config.duplicateLiteralMinLines;
  const introduced = new Set(introducedPaths.map((path) => normalizePath(path).toLowerCase()));
  const requireIntroduced = introduced.size > 0;
  const blockMap = new Map<string, Location[]>();
  const seedPaths = requireIntroduced
    ? [...files.keys()].filter((path) => introduced.has(path.toLowerCase()))
    : [...files.keys()];
  for (const path of seedPaths) {
    for (const block of blocks(files.get(path) ?? [], size)) {
      const locations = blockMap.get(block.text) ?? [];
      locations.push({ file: path, startLine: block.startLine, endLine: block.endLine });
      blockMap.set(block.text, locations);
    }
  }
  if (requireIntroduced && blockMap.size > 0) {
    for (const [path, lines] of files) {
      if (introduced.has(path.toLowerCase())) continue;
      for (const block of blocks(lines, size)) {
        const locations = blockMap.get(block.text);
        if (locations) locations.push({ file: path, startLine: block.startLine, endLine: block.endLine });
      }
    }
  }

  const renames = renameMap(root, baseRef, headRef);
  const baseCache = new Map<string, Set<string>>();
  const novelAtPath = (path: string, text: string): boolean => {
    if (!baseRef) return true;
    const normalized = normalizePath(path);
    const oldPath = renames.get(normalized.toLowerCase()) ?? normalized;
    const key = oldPath + '\0' + String(size);
    let set = baseCache.get(key);
    if (!set) {
      const lines = baseLines(root, baseRef, oldPath);
      if (lines.length === 0) return true;
      set = new Set(blocks(lines, size).map((item) => item.text));
      baseCache.set(key, set);
    }
    return !set.has(text);
  };

  const findings: Finding[] = [];
  for (const [text, locations] of blockMap) {
    const distinctFiles = [...new Set(locations.map((item) => item.file))].sort();
    if (distinctFiles.length < 2) continue;
    if (suppressed(config, 'duplicate-literal', distinctFiles)) continue;
    if (requireIntroduced) {
      const touched = distinctFiles.filter((path) => introduced.has(path.toLowerCase()));
      if (touched.length === 0) continue;
      if (baseRef && !touched.some((path) => novelAtPath(path, text))) continue;
    }
    findings.push({
      rule: 'duplicate-literal',
      severity: 'strict',
      rationale: 'Exact duplicate prompt literal (' + String(size) + ' lines) across ' + String(distinctFiles.length) + ' files; centralize into one source of truth.',
      locations: [...locations].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
    });
  }
  return findings;
}

function fileKind(path: string, config: Config): 'script' | 'template' | 'other' {
  const extension = extname(path).toLowerCase();
  if (config.scriptExtensions.includes(extension)) return 'script';
  if (config.templateExtensions.includes(extension)) return 'template';
  return 'other';
}

function pairedFindings(files: Map<string, string[]>, changed: readonly string[], config: Config): Finding[] {
  const changedSet = new Set(changed.map((path) => normalizePath(path).toLowerCase()));
  const scripts = [...files.keys()].filter((path) => changedSet.has(path.toLowerCase()) && fileKind(path, config) === 'script');
  const templates = [...files.keys()].filter((path) => changedSet.has(path.toLowerCase()) && fileKind(path, config) === 'template');
  const size = config.pairedEditMinLines;
  const stride = Math.max(1, config.pairedLineStride);
  const findings: Finding[] = [];
  for (const scriptPath of scripts) {
    for (const templatePath of templates) {
      if (suppressed(config, 'paired-edit-divergence', [scriptPath, templatePath])) continue;
      const left = files.get(scriptPath) ?? [];
      const right = files.get(templatePath) ?? [];
      let best: { si: number; ti: number; matching: number; ratio: number } | null = null;
      if (left.length < size || right.length < size) continue;
      for (let si = 0; si <= left.length - size; si += stride) {
        for (let ti = 0; ti <= right.length - size; ti += stride) {
          let matching = 0;
          for (let k = 0; k < size; k += 1) if (left[si + k] === right[ti + k]) matching += 1;
          if (matching === size || matching < config.pairedOverlapMinLines) continue;
          const ratio = matching / size;
          if (ratio < config.pairedOverlapMinRatio) continue;
          if (!best || ratio > best.ratio) best = { si, ti, matching, ratio };
        }
      }
      if (!best) continue;
      findings.push({
        rule: 'paired-edit-divergence',
        severity: 'strict',
        rationale: 'Paired script/template edit: shared ' + String(size) + '-line block diverged (' + String(best.matching) + '/' + String(size) + ' lines, ' + String(Math.trunc(best.ratio * 100)) + '% overlap); extract or generate from one source.',
        locations: [
          { file: scriptPath, startLine: best.si + 1, endLine: best.si + size },
          { file: templatePath, startLine: best.ti + 1, endLine: best.ti + size },
        ],
      });
    }
  }
  return findings;
}

function heuristicFindings(files: Map<string, string[]>, config: Config): Finding[] {
  const paths = [...files.keys()];
  const findings: Finding[] = [];
  const stride = Math.max(1, config.heuristicLineStride);
  for (let i = 0; i < paths.length && findings.length < Math.max(1, config.heuristicMaxFindings); i += 1) {
    for (let j = i + 1; j < paths.length && findings.length < Math.max(1, config.heuristicMaxFindings); j += 1) {
      const leftPath = paths[i]!;
      const rightPath = paths[j]!;
      const left = files.get(leftPath) ?? [];
      const right = files.get(rightPath) ?? [];
      if (config.heuristicMaxFileLines > 0 && (left.length > config.heuristicMaxFileLines || right.length > config.heuristicMaxFileLines)) continue;
      for (let size = config.heuristicMinLines; size <= config.heuristicMaxLines && findings.length < config.heuristicMaxFindings; size += 1) {
        for (let li = 0; li <= left.length - size && findings.length < config.heuristicMaxFindings; li += stride) {
          for (let ri = 0; ri <= right.length - size && findings.length < config.heuristicMaxFindings; ri += stride) {
            let matching = 0;
            for (let k = 0; k < size; k += 1) if (left[li + k] === right[ri + k]) matching += 1;
            const similarity = matching / size;
            if (similarity < config.similarityThreshold || similarity >= 1) continue;
            if (suppressed(config, 'near-duplicate-literal', [leftPath, rightPath])) continue;
            findings.push({
              rule: 'near-duplicate-literal',
              severity: 'warning',
              rationale: 'Near-duplicate literal block (~' + String(Math.trunc(similarity * 100)) + '% line match, ' + String(size) + ' lines); consider extracting a shared source.',
              locations: [
                { file: leftPath, startLine: li + 1, endLine: li + size },
                { file: rightPath, startLine: ri + 1, endLine: ri + size },
              ],
            });
          }
        }
      }
    }
  }
  return findings;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    strict: false,
    baseRef: '',
    headRef: 'HEAD',
    configPath: '',
    repoRoot: '',
    withWorkingTree: false,
    fixtureRoot: '',
  };
  const aliases = new Map<string, keyof Options>([
    ['--base-ref', 'baseRef'], ['-BaseRef', 'baseRef'],
    ['--head-ref', 'headRef'], ['-HeadRef', 'headRef'],
    ['--config-path', 'configPath'], ['-ConfigPath', 'configPath'],
    ['--repo-root', 'repoRoot'], ['-RepoRoot', 'repoRoot'],
    ['--fixture-root', 'fixtureRoot'], ['-FixtureRoot', 'fixtureRoot'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--strict' || arg === '-Strict') options.strict = true;
    else if (arg === '--with-working-tree' || arg === '-WithWorkingTree') options.withWorkingTree = true;
    else {
      const key = aliases.get(arg);
      if (!key) throw new Error('unknown argument: ' + arg);
      const value = argv[++i];
      if (!value) throw new Error('missing value for ' + arg);
      if (key === 'baseRef' || key === 'headRef' || key === 'configPath' || key === 'repoRoot' || key === 'fixtureRoot') options[key] = value;
    }
  }
  return options;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  let root = resolve(options.repoRoot || resolve(import.meta.dirname, '..'));
  const configPath = options.configPath
    ? resolve(options.configPath)
    : join(import.meta.dirname, 'lint-self-architect.config.json');
  const config = readConfig(configPath);

  let changed: string[];
  if (options.fixtureRoot) {
    const fixture = resolve(root, options.fixtureRoot);
    root = fixture;
    changed = fixtureFiles(fixture);
  } else {
    changed = changedPaths(root, options.baseRef, options.headRef, options.withWorkingTree);
  }
  const scanPaths = changed.filter((path) => shouldScan(path, config));
  let comparisonPaths: string[];
  if (options.fixtureRoot) {
    comparisonPaths = scanPaths;
  } else if (options.baseRef && scanPaths.length === 0) {
    comparisonPaths = [];
  } else {
    const set = new Set(gitLines(root, ['ls-files']).map(normalizePath).filter((path) => shouldScan(path, config)));
    for (const path of scanPaths) set.add(path);
    comparisonPaths = [...set];
  }

  const files = new Map<string, string[]>();
  for (const path of comparisonPaths) {
    const full = join(root, path);
    if (existsSync(full) && lstatSync(full).isFile()) files.set(path, textLines(full));
  }
  const heuristicFiles = new Map<string, string[]>();
  for (const path of scanPaths) {
    const lines = files.get(path);
    if (lines) heuristicFiles.set(path, lines);
  }

  const findings: Finding[] = [
    ...duplicateFindings(files, scanPaths, config, root, options.baseRef, options.headRef),
    ...pairedFindings(files, changed, config),
  ];
  if (!options.strict) findings.push(...heuristicFindings(heuristicFiles, config));

  const strict = findings.filter((finding) => finding.severity === 'strict');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  console.log('== self-architect lint ==');
  console.log('Root: ' + root);
  if (options.baseRef) console.log('Diff: ' + options.baseRef + '...' + options.headRef);
  else if (options.fixtureRoot) console.log('Fixture: ' + options.fixtureRoot);
  else console.log('Scope: staged changes' + (options.withWorkingTree ? ' + unstaged/untracked' : ''));
  console.log('Changed files: ' + String(scanPaths.length));
  console.log('Comparison files: ' + String(comparisonPaths.length));
  if (options.strict) console.log('Heuristic near-duplicate scan: skipped (-Strict / CI mode)');
  console.log('');
  if (findings.length === 0) console.log('No findings.');
  for (const finding of findings) {
    const locations = finding.locations.map((loc) => loc.file + ':' + String(loc.startLine) + '-' + String(loc.endLine)).join(', ');
    console.log('[' + (finding.severity === 'strict' ? 'STRICT' : 'WARN') + '] ' + finding.rule + ': ' + locations + ' - ' + finding.rationale);
  }
  console.log('');
  console.log('Summary: strict=' + String(strict.length) + ' warning=' + String(warnings.length));
  return options.strict && strict.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
