import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(new URL('../contract-evidence-reverify-allowlist.json', import.meta.url)));

export interface ProductionCommandRegistration {
  id: string;
  proofCommand: string;
  independentProducerCommand: string;
  trustedNodePrefix?: string;
}

export interface ReverifyAllowlistConfig {
  description?: string;
  externalProducers: string[];
  allowedEnvVars: string[];
  trustedCommandPrefixes: string[];
  mutatingTokenPattern: string;
  trustedCheckerRelativePaths: string[];
  newRowProducerBoundaryScripts?: string[];
  npmProofIndependentCommands: Record<string, string>;
  defaultTimeoutMs: number;
  maxObservedLength: number;
  productionCommandsManifest?: string;
}

type RawAllowlist = Omit<ReverifyAllowlistConfig, 'npmProofIndependentCommands'> & {
  npmProofIndependentCommands?: Record<string, string>;
};

type ProductionCommandsManifest = {
  registrations?: ProductionCommandRegistration[];
};

function loadProductionRegistrations(manifestRelPath: string): ProductionCommandRegistration[] {
  const manifestPath = path.isAbsolute(manifestRelPath)
    ? manifestRelPath
    : path.join(scriptsDir, path.basename(manifestRelPath));
  const manifest = require(manifestPath) as ProductionCommandsManifest;
  const registrations = manifest.registrations ?? [];
  for (const entry of registrations) {
    if (!entry.id || !entry.proofCommand || !entry.independentProducerCommand) {
      throw new Error(`invalid production command registration: ${entry.id || '<missing id>'}`);
    }
  }
  return registrations;
}

export function mergeProductionCommandRegistrations(
  base: RawAllowlist,
  registrations: ProductionCommandRegistration[],
): ReverifyAllowlistConfig {
  const trustedCommandPrefixes = [...base.trustedCommandPrefixes];
  const npmProofIndependentCommands = { ...(base.npmProofIndependentCommands ?? {}) };

  for (const entry of registrations) {
    if (!trustedCommandPrefixes.includes(entry.proofCommand)) {
      trustedCommandPrefixes.push(entry.proofCommand);
    }
    npmProofIndependentCommands[entry.proofCommand] = entry.independentProducerCommand;
    if (entry.trustedNodePrefix) {
      const nodePrefix = `node ${entry.trustedNodePrefix}`;
      if (!trustedCommandPrefixes.includes(nodePrefix)) {
        trustedCommandPrefixes.push(nodePrefix);
      }
    }
  }

  return {
    ...base,
    trustedCommandPrefixes,
    npmProofIndependentCommands,
  };
}

export function loadReverifyAllowlistConfig(
  allowlistPath = path.join(scriptsDir, 'contract-evidence-reverify-allowlist.json'),
): ReverifyAllowlistConfig {
  const base = require(allowlistPath) as RawAllowlist;
  if (!base.productionCommandsManifest) {
    return {
      ...base,
      npmProofIndependentCommands: base.npmProofIndependentCommands ?? {},
    };
  }
  const registrations = loadProductionRegistrations(base.productionCommandsManifest);
  return mergeProductionCommandRegistrations(base, registrations);
}
