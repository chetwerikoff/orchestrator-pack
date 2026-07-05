#!/usr/bin/env node
import { originSlugFromGitConfig } from './git-origin-slug.mjs';

function parsePackRoot(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pack-root' && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return null;
}

const packRoot = parsePackRoot(process.argv.slice(2));
if (!packRoot) {
  process.exit(0);
}

const slug = originSlugFromGitConfig(packRoot);
if (slug) {
  process.stdout.write(slug);
}
