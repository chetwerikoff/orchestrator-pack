// Operator configuration for discuss-with-gpt (env + optional local file).
// Required: projectUrl, chromeUserDataDir
// Optional: chromePath (WSL default: standard Chrome install under /mnt/c)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG = join(SKILL_DIR, 'local.config.json');

const ENV = {
  projectUrl: 'DISCUSS_WITH_GPT_PROJECT_URL',
  chromeUserDataDir: 'DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR',
  chromePath: 'DISCUSS_WITH_GPT_CHROME_PATH',
};

function loadLocalConfig() {
  if (!existsSync(LOCAL_CONFIG)) return {};
  try {
    return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${LOCAL_CONFIG}: ${(e && e.message) || e}`);
  }
}

function pick(key, local) {
  const fromEnv = process.env[ENV[key]];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = local[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return undefined;
}

export function resolveDiscussWithGptConfig({ requireProjectUrl = true, requireProfile = true } = {}) {
  const local = loadLocalConfig();
  const projectUrl = pick('projectUrl', local);
  const chromeUserDataDir = pick('chromeUserDataDir', local);
  const chromePath =
    pick('chromePath', local) || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

  const missing = [];
  if (requireProjectUrl && !projectUrl) missing.push(ENV.projectUrl);
  if (requireProfile && !chromeUserDataDir) missing.push(ENV.chromeUserDataDir);

  if (missing.length) {
    const hint =
      `Set ${missing.join(' and ')}` +
      `, or copy local.config.example.json → local.config.json in this skill dir.`;
    const err = new Error(`discuss-with-gpt: operator configuration missing. ${hint}`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }

  return { projectUrl, chromeUserDataDir, chromePath, localConfigPath: LOCAL_CONFIG };
}

// --shell: print export statements for launch-chrome.sh
if (process.argv.includes('--shell')) {
  let cfg;
  try {
    cfg = resolveDiscussWithGptConfig();
  } catch (e) {
    console.error((e && e.message) || e);
    process.exit(1);
  }
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  console.log(`export DISCUSS_WITH_GPT_PROJECT_URL=${q(cfg.projectUrl)}`);
  console.log(`export DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR=${q(cfg.chromeUserDataDir)}`);
  console.log(`export DISCUSS_WITH_GPT_CHROME_PATH=${q(cfg.chromePath)}`);
}
