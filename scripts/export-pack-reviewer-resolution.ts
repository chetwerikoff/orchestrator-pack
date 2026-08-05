import { resolvePackReviewerResolution } from './lib/resolve-pack-reviewer.ts';

const unexpected = process.argv.slice(2);
if (unexpected.length > 0) {
  throw new Error(`Unknown reviewer resolution export arguments: ${unexpected.join(' ')}`);
}

const resolution = resolvePackReviewerResolution(process.env);
process.stdout.write(`${JSON.stringify({
  schema: 'pack-reviewer-resolution/v1',
  selectorValue: resolution.selectorValue,
  reviewer: resolution.reviewer,
  source: resolution.source,
  preferencePath: resolution.preferencePath,
  errorMessage: resolution.errorMessage,
})}\n`);
