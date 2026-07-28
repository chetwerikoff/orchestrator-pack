import { resolvePackReviewerResolution } from './lib/resolve-pack-reviewer.ts';

function parseOverrideLayersJson(raw: string | undefined): Record<string, string | null> | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Record<string, string | null>;
  return parsed;
}

function parseArgs(argv: string[]): {
  overrideLayers?: Record<string, string | null>;
  emulateWin32: boolean;
} {
  let overrideLayers: Record<string, string | null> | undefined;
  let emulateWin32 = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--override-layers-json') {
      overrideLayers = parseOverrideLayersJson(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--harness-emulate-persistent-layers') {
      emulateWin32 = true;
    }
  }
  return { overrideLayers, emulateWin32 };
}

const { overrideLayers, emulateWin32 } = parseArgs(process.argv.slice(2));
const resolution = resolvePackReviewerResolution(process.env, {
  layerOverrides: overrideLayers,
  emulateWin32,
});
process.stdout.write(`${JSON.stringify({
  schema: 'pack-reviewer-resolution/v1',
  ...resolution,
})}\n`);
