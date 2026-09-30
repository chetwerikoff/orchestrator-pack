// Operator configuration for discuss-with-gpt.
// Target identity/project URL comes only from the selected project card.
// Machine-wide browser settings may come from env + optional local file.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../../../scripts/kernel/subprocess.ts';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG = join(SKILL_DIR, 'local.config.json');
const TARGET_CONTEXT = resolve(SKILL_DIR, '../../../scripts/lib/target-context.ts');

const ENV = {
  chromeUserDataDir: 'DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR',
  chromePath: 'DISCUSS_WITH_GPT_CHROME_PATH',
};

function loadLocalConfig() {
  if (!existsSync(LOCAL_CONFIG)) return {};
  try { return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')); }
  catch (e) { throw new Error('Failed to parse ' + LOCAL_CONFIG + ': ' + ((e && e.message) || e)); }
}

function pick(key, local) {
  const fromEnv = process.env[ENV[key]];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = local[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return undefined;
}

function cardDirectory() {
  const home = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config');
  return join(home, 'orchestrator-pack', 'projects');
}

function resolveTarget(projectId) {
  const args = ['--experimental-strip-types', TARGET_CONTEXT, 'check'];
  if (projectId) args.push('--project', projectId);
  const child = runProcessSync({
    command: process.execPath,
    args,
    env: process.env,
    inheritParentEnv: true,
  });
  if (!child.ok) {
    let detail = String(child.stderr || child.error || '').trim();
    try { const parsed = JSON.parse(detail); detail = parsed.message || detail; } catch { /* exact resolver diagnostic */ }
    throw new Error(
      'discuss-with-gpt: target project unresolved. ' + (detail || 'target-context check failed') + '. ' +
      'Browser-GPT projectUrl belongs in ' + join(cardDirectory(), '<projectId>.json'),
    );
  }
  try { return JSON.parse(String(child.stdout || '').trim()); }
  catch { throw new Error('discuss-with-gpt: target-context check returned malformed output'); }
}

export function resolveDiscussWithGptConfig({ projectId, requireProjectUrl = true, requireProfile = true, requireChromePath = false } = {}) {
  const local = loadLocalConfig();
  if (typeof local.projectUrl === 'string' && local.projectUrl.trim()) {
    throw new Error(
      'discuss-with-gpt: legacy projectUrl in ' + LOCAL_CONFIG + ' is not target authority; move it to ' +
      join(cardDirectory(), '<projectId>.json') + ' and select that project with --project or OPK_PROJECT_ID.',
    );
  }
  if (process.env.DISCUSS_WITH_GPT_PROJECT_URL?.trim()) {
    throw new Error(
      'discuss-with-gpt: DISCUSS_WITH_GPT_PROJECT_URL is retired as target authority; use ' +
      join(cardDirectory(), '<projectId>.json') + ' with --project or OPK_PROJECT_ID.',
    );
  }
  const target = requireProjectUrl ? resolveTarget(projectId) : undefined;
  const chromeUserDataDir = pick('chromeUserDataDir', local);
  const chromePath = pick('chromePath', local);
  if (requireChromePath && !chromePath) {
    const err = new Error('discuss-with-gpt: chromePath is required to launch Chrome. Set ' + ENV.chromePath + ' or chromePath in ' + LOCAL_CONFIG + '.');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  if (requireProfile && !chromeUserDataDir) {
    const err = new Error('discuss-with-gpt: operator configuration missing. Set ' + ENV.chromeUserDataDir + ' or chromeUserDataDir in ' + LOCAL_CONFIG + '.');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  return {
    projectId: target?.projectId,
    repository: target?.repository,
    projectUrl: target?.projectUrl,
    cardPath: target?.cardPath,
    chromeUserDataDir, chromePath, localConfigPath: LOCAL_CONFIG,
  };
}

function cliProjectId(argv) {
  const indexes = argv.flatMap((value, index) => value === '--project' ? [index] : []);
  if (indexes.length > 1) throw new Error('duplicate argument: --project');
  if (indexes.length === 0) return undefined;
  const value = String(argv[indexes[0] + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error('--project requires a value');
  return value;
}

if (process.argv.includes('--shell')) {
  let cfg;
  try { cfg = resolveDiscussWithGptConfig({ projectId: cliProjectId(process.argv.slice(2)), requireChromePath: true }); }
  catch (e) { console.error((e && e.message) || e); process.exit(1); }
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  console.log('export DISCUSS_WITH_GPT_PROJECT_URL=' + q(cfg.projectUrl));
  console.log('export DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR=' + q(cfg.chromeUserDataDir));
  console.log('export DISCUSS_WITH_GPT_CHROME_PATH=' + q(cfg.chromePath));
}
