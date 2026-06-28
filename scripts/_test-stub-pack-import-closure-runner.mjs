import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function reportFailure(moduleName, missingDep, message) {
  console.error(JSON.stringify({ module: moduleName, missingDep, message }));
  process.exit(1);
}

function parseMissingDep(err, moduleName) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND') {
    return { missingDep: '(unresolved)', message };
  }

  const quoted = message.match(/Cannot find module '([^']+)' imported from/);
  if (quoted) {
    const missingPath = quoted[1];
    return {
      missingDep: missingPath.endsWith('.mjs') ? path.basename(missingPath) : missingPath,
      message,
    };
  }

  const bare = message.match(/Cannot find module ([^\s]+) imported from/);
  if (bare) {
    const missingPath = bare[1];
    return {
      missingDep: missingPath.endsWith('.mjs') ? path.basename(missingPath) : missingPath,
      message,
    };
  }

  return { missingDep: '(unresolved)', message: `${moduleName}: ${message}` };
}

const docsDir = process.argv[2];
if (!docsDir) {
  console.error('usage: node _test-stub-pack-import-closure-runner.mjs <pack-docs-dir>');
  process.exit(2);
}

const entryModules = readdirSync(docsDir)
  .filter((name) => name.endsWith('.mjs'))
  .sort();

for (const fileName of entryModules) {
  const modulePath = path.join(docsDir, fileName);
  try {
    await import(pathToFileURL(modulePath).href);
  } catch (err) {
    const { missingDep, message } = parseMissingDep(err, fileName);
    reportFailure(fileName, missingDep, message);
  }
}
