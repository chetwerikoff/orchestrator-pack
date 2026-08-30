export const EXECUTOR_PROFILE_REFUSALS = [
  'executor_route_unavailable',
  'executor_effort_channel_unavailable',
  'executor_route_mismatch',
] as const;

export const EXECUTOR_PROFILE_REFUSAL = {
  routeUnavailable: EXECUTOR_PROFILE_REFUSALS[0],
  effortChannelUnavailable: EXECUTOR_PROFILE_REFUSALS[1],
  routeMismatch: EXECUTOR_PROFILE_REFUSALS[2],
} as const;

export type ExecutorProfileRefusal = (typeof EXECUTOR_PROFILE_REFUSALS)[number];
export type ExecutorFamily = 'cursor' | 'opencode';
export type ExecutorProfileSurface = 'task' | 'smoke';
export type ExecutorRoute = 'provider_new_top_level' | 'exact_terminal_worktree';
export type TaskProfileClass = 'manager' | 't1' | 't2' | 't3';
export type SmokeProfileClass = 'routine' | 'complex';
export type ExecutorProfileClass = TaskProfileClass | `smoke_${SmokeProfileClass}`;

export type ExecutorProfileNames = readonly [string, string, string];

export interface ExecutorFamilyDescriptor {
  readonly family: ExecutorFamily;
  readonly taskAgentToken: string;
  readonly smokeAgentToken: string;
  readonly taskExecutable: string;
  readonly smokeExecutable: string;
  readonly orcaAgent: string;
  readonly catalogCommand: readonly string[];
  readonly capabilityProbeCommands: readonly (readonly string[])[];
  readonly smokeCapabilityProbeCommands: readonly (readonly string[])[];
  readonly contextualProbeCommands: readonly (readonly string[])[];
}

export interface SemanticExecutorProfile {
  readonly family: ExecutorFamily;
  readonly surface: ExecutorProfileSurface;
  readonly model: string;
  readonly effort: string;
  readonly cursorContext?: string;
  readonly names: ExecutorProfileNames;
}

export type SemanticProfileResolution =
  | { readonly ok: true; readonly profile: SemanticExecutorProfile }
  | {
      readonly ok: false;
      readonly code: 'executor_profile_missing' | 'executor_profile_malformed' | 'executor_profile_agent_unsupported';
      readonly variables: readonly string[];
    };

export interface RouteCapability {
  readonly available: boolean;
  readonly supportsModel: boolean;
  readonly supportsEffort: boolean;
  readonly smokeRuntimeAvailable?: boolean;
  readonly supportedEffortsByModel?: Readonly<Record<string, readonly string[]>>;
}

export interface ExecutorEdgeCapabilities {
  readonly provider: RouteCapability;
  readonly exactTerminal: RouteCapability;
}

export type RouteAdmissionVerdict =
  | { readonly ok: true; readonly route: ExecutorRoute }
  | { readonly ok: false; readonly refusal: ExecutorProfileRefusal };

export type SpawnApplicabilityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: 'executor_route_unavailable' | 'executor_effort_channel_unavailable' };

export const OPENCODE_PACK_AGENT = 'pack' as const;

export interface ExecutorInvocationShape {
  readonly executable: string;
  readonly command: string;
  readonly modelArgument?: string;
  readonly effortArgument?: string;
  readonly agentName?: string;
  readonly inlineConfigJson?: string;
}

export interface ProviderInvocationShape {
  readonly orcaAgent: string;
  readonly argv: readonly string[];
}

export const EXECUTOR_PROFILE_VARIABLES: Readonly<Record<ExecutorProfileClass, ExecutorProfileNames>> = {
  manager: ['PACK_EXECUTOR_MANAGER_AGENT', 'PACK_EXECUTOR_MANAGER_MODEL', 'PACK_EXECUTOR_MANAGER_EFFORT'],
  t1: ['PACK_EXECUTOR_T1_AGENT', 'PACK_EXECUTOR_T1_MODEL', 'PACK_EXECUTOR_T1_EFFORT'],
  t2: ['PACK_EXECUTOR_T2_AGENT', 'PACK_EXECUTOR_T2_MODEL', 'PACK_EXECUTOR_T2_EFFORT'],
  t3: ['PACK_EXECUTOR_T3_AGENT', 'PACK_EXECUTOR_T3_MODEL', 'PACK_EXECUTOR_T3_EFFORT'],
  smoke_routine: ['PACK_EXECUTOR_SMOKE_ROUTINE_AGENT', 'PACK_EXECUTOR_SMOKE_ROUTINE_MODEL', 'PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT'],
  smoke_complex: ['PACK_EXECUTOR_SMOKE_COMPLEX_AGENT', 'PACK_EXECUTOR_SMOKE_COMPLEX_MODEL', 'PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT'],
};

export const EXECUTOR_FAMILY_DESCRIPTORS: Readonly<Record<ExecutorFamily, ExecutorFamilyDescriptor>> = {
  cursor: {
    family: 'cursor',
    taskAgentToken: 'cursor-agent',
    smokeAgentToken: 'cursor',
    taskExecutable: 'cursor-agent',
    smokeExecutable: 'agent',
    orcaAgent: 'cursor',
    catalogCommand: ['cursor-agent', '--list-models'],
    capabilityProbeCommands: [],
    smokeCapabilityProbeCommands: [],
    contextualProbeCommands: [],
  },
  opencode: {
    family: 'opencode',
    taskAgentToken: 'opencode',
    smokeAgentToken: 'opencode',
    taskExecutable: 'opencode',
    smokeExecutable: 'opencode',
    orcaAgent: 'opencode',
    catalogCommand: ['opencode', 'models'],
    capabilityProbeCommands: [
      ['opencode', '--help'],
      ['opencode', 'models', '--verbose'],
    ],
    smokeCapabilityProbeCommands: [
      ['opencode', '--help'],
      ['opencode', 'models', '--verbose'],
    ],
    contextualProbeCommands: [
      ['opencode', 'debug', 'config'],
      ['opencode', 'debug', 'agent'],
      ['opencode', 'debug', 'agent'],
      ['opencode', 'debug', 'paths'],
    ],
  },
};

export const CURSOR_TASK_ROUTE_CAPABILITIES: ExecutorEdgeCapabilities = {
  provider: { available: true, supportsModel: true, supportsEffort: true },
  exactTerminal: { available: true, supportsModel: true, supportsEffort: true },
};

export const CURSOR_SMOKE_CAPABILITY: RouteCapability = {
  available: true,
  supportsModel: true,
  supportsEffort: true,
};

const PROFILE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u;
const MODEL_TOKEN_CLASS = 'A-Za-z0-9._:/+-';
const CURSOR_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const CURSOR_SPAWN_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*\[context=[A-Za-z0-9][A-Za-z0-9._+-]*,reasoning=[A-Za-z0-9][A-Za-z0-9._:/+-]*,fast=false\]$/u;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function descriptorForToken(surface: ExecutorProfileSurface, token: string): ExecutorFamilyDescriptor | undefined {
  return Object.values(EXECUTOR_FAMILY_DESCRIPTORS).find((descriptor) =>
    surface === 'task' ? descriptor.taskAgentToken === token : descriptor.smokeAgentToken === token,
  );
}

export function profileNamesForTask(workClass: TaskProfileClass): ExecutorProfileNames {
  return EXECUTOR_PROFILE_VARIABLES[workClass];
}

export function profileNamesForSmoke(complexity: SmokeProfileClass): ExecutorProfileNames {
  return EXECUTOR_PROFILE_VARIABLES[`smoke_${complexity}`];
}

export function resolveSemanticExecutorProfile(input: {
  readonly surface: ExecutorProfileSurface;
  readonly names: ExecutorProfileNames;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}): SemanticProfileResolution {
  const values = input.names.map((name) => input.env[name]?.trim() ?? '') as [string, string, string];
  const missing = input.names.filter((_name, index) => !values[index]);
  if (missing.length) return { ok: false, code: 'executor_profile_missing', variables: missing };

  const malformed = input.names.filter((_name, index) => !PROFILE_VALUE_PATTERN.test(values[index]!));
  if (malformed.length) return { ok: false, code: 'executor_profile_malformed', variables: malformed };

  const descriptor = descriptorForToken(input.surface, values[0]);
  if (!descriptor) return { ok: false, code: 'executor_profile_agent_unsupported', variables: [input.names[0]] };

  const rawCursorContext = input.env.PACK_EXECUTOR_CURSOR_CONTEXT;
  const cursorContext = descriptor.family === 'cursor' && rawCursorContext !== undefined
    ? rawCursorContext.trim()
    : undefined;
  if (cursorContext !== undefined && !CURSOR_CONTEXT_PATTERN.test(cursorContext)) {
    return { ok: false, code: 'executor_profile_malformed', variables: ['PACK_EXECUTOR_CURSOR_CONTEXT'] };
  }

  return {
    ok: true,
    profile: {
      family: descriptor.family,
      surface: input.surface,
      model: values[1],
      effort: values[2],
      ...(cursorContext !== undefined ? { cursorContext } : {}),
      names: input.names,
    },
  };
}

export function cursorOpaqueModelId(profile: Pick<SemanticExecutorProfile, 'family' | 'model' | 'effort'>): string {
  if (profile.family !== 'cursor') throw new Error('cursor_translation_family_mismatch');
  return `${profile.model}-${profile.effort}`;
}

export function catalogIdentityForProfile(profile: SemanticExecutorProfile): string {
  return profile.family === 'cursor' ? cursorOpaqueModelId(profile) : profile.model;
}

function cursorSpawnModelId(profile: SemanticExecutorProfile): string {
  const opaqueModelId = cursorOpaqueModelId(profile);
  if (profile.cursorContext === undefined) return opaqueModelId;
  const modelArgument = `${profile.model}[context=${profile.cursorContext},reasoning=${profile.effort},fast=false]`;
  if (!CURSOR_SPAWN_MODEL_PATTERN.test(modelArgument)) throw new Error('cursor_spawn_model_invalid');
  return modelArgument;
}

export function executorCatalogContains(profile: SemanticExecutorProfile, output: string): boolean {
  const identity = catalogIdentityForProfile(profile);
  if (!identity || !PROFILE_VALUE_PATTERN.test(identity)) return false;
  const pattern = new RegExp(`(^|[^${MODEL_TOKEN_CLASS}])${regexEscape(identity)}(?=$|[^${MODEL_TOKEN_CLASS}])`, 'mu');
  return pattern.test(output);
}

function jsonObjectAt(output: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed: unknown = JSON.parse(output.slice(start, index + 1));
      return record(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function variantNames(metadata: Record<string, unknown>): readonly string[] {
  const variants = metadata.variants;
  if (record(variants)) return Object.keys(variants).filter((name) => PROFILE_VALUE_PATTERN.test(name));
  if (Array.isArray(variants)) return variants
    .map((value) => record(value) && typeof value.id === 'string' ? value.id.trim() : '')
    .filter((name) => PROFILE_VALUE_PATTERN.test(name));
  return [];
}

export function openCodeVariantCatalog(output: string): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, readonly string[]> = {};
  const identityLines = /^([A-Za-z0-9][A-Za-z0-9._:/+-]*)\r?$/gmu;
  for (const match of output.matchAll(identityLines)) {
    const identity = match[1]!;
    let cursor = (match.index ?? 0) + match[0].length;
    while (cursor < output.length && /\s/u.test(output[cursor]!)) cursor += 1;
    if (output[cursor] !== '{') continue;
    const metadata = jsonObjectAt(output, cursor);
    if (!metadata) continue;
    result[identity] = variantNames(metadata);
  }
  return result;
}

export function openCodeTuiCapability(tuiHelp: string): RouteCapability {
  const hasAgent = /(^|\s)--agent(?:[=\s,]|$)/mu.test(tuiHelp);
  return {
    available: hasAgent,
    supportsModel: hasAgent,
    supportsEffort: false,
  };
}

export function parseOpenCodeResolvedAgent(output: string): { providerID: string; modelID: string; variant: string } | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!record(parsed)) return null;
    const model = record(parsed.model) ? parsed.model : null;
    const providerID = typeof model?.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model?.modelID === 'string' ? model.modelID.trim() : '';
    const variant = typeof parsed.variant === 'string' ? parsed.variant.trim() : '';
    if (!providerID || !modelID) return null;
    return { providerID, modelID, variant };
  } catch {
    return null;
  }
}

export function openCodeEdgeCapabilities(
  probeOutputs: readonly string[],
  profile?: SemanticExecutorProfile,
): ExecutorEdgeCapabilities {
  const tui = openCodeTuiCapability(probeOutputs[0] ?? '');
  const catalog = openCodeVariantCatalog(probeOutputs[1] ?? '');
  const debugOutput = probeOutputs[2] ?? '';
  let effortViaAgent = false;
  if (profile && profile.family === 'opencode' && debugOutput.trim()) {
    const resolved = parseOpenCodeResolvedAgent(debugOutput);
    if (resolved) {
      const profileModelID = profile.model.includes('/') ? profile.model.split('/').pop()! : profile.model;
      const profileProvider = profile.model.includes('/') ? profile.model.split('/')[0]! : 'opencode';
      const variantMatches = resolved.variant === profile.effort;
      const modelMatches = resolved.modelID === profileModelID && resolved.providerID === profileProvider;
      const catalogEfforts = catalog[profile.model] ?? [];
      const catalogMatches = catalogEfforts.includes(profile.effort);
      effortViaAgent = Boolean(variantMatches && modelMatches && catalogMatches);
    }
  } else if (profile?.family === 'opencode') {
    effortViaAgent = (catalog[profile.model] ?? []).includes(profile.effort);
  }
  const exactTerminal: RouteCapability = {
    available: tui.available,
    supportsModel: tui.supportsModel,
    supportsEffort: effortViaAgent,
    supportedEffortsByModel: catalog,
  };

  // The provider path stays closed in this package revision unless the downstream
  // supervised-start validator is changed from fresh implementation-time evidence.
  // Merely observing provider help is intentionally not enough to authorize it.
  return {
    provider: { available: false, supportsModel: false, supportsEffort: false },
    exactTerminal,
  };
}

export function evaluateExecutorSpawnApplicability(capability: RouteCapability): SpawnApplicabilityVerdict {
  if (capability.available && capability.supportsModel && !capability.supportsEffort) {
    return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.effortChannelUnavailable };
  }
  if (capability.smokeRuntimeAvailable === false) {
    return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
  }
  if (capability.available && capability.supportsModel && capability.supportsEffort) return { ok: true };
  return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
}

function routeCapability(capabilities: ExecutorEdgeCapabilities, route: ExecutorRoute): RouteCapability {
  return route === 'provider_new_top_level' ? capabilities.provider : capabilities.exactTerminal;
}

function routeSupportsSelectedEffort(capability: RouteCapability, profile: SemanticExecutorProfile): boolean {
  if (!capability.supportsEffort) return false;
  if (profile.family !== 'opencode') return true;
  const supported = capability.supportedEffortsByModel?.[profile.model] ?? [];
  return supported.includes(profile.effort);
}

function routeAdmitted(capability: RouteCapability, profile: SemanticExecutorProfile): boolean {
  return capability.available && capability.supportsModel && routeSupportsSelectedEffort(capability, profile);
}

export function evaluateExecutorRouteAdmission(input: {
  readonly profile: SemanticExecutorProfile;
  readonly startMode?: ExecutorRoute;
  readonly edgeCapabilities: ExecutorEdgeCapabilities;
}): RouteAdmissionVerdict {
  const providerAdmitted = routeAdmitted(input.edgeCapabilities.provider, input.profile);
  const exactAdmitted = routeAdmitted(input.edgeCapabilities.exactTerminal, input.profile);

  if (input.startMode) {
    const requested = routeCapability(input.edgeCapabilities, input.startMode);
    if (routeAdmitted(requested, input.profile)) return { ok: true, route: input.startMode };
    if (providerAdmitted || exactAdmitted) return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeMismatch };
    if (requested.available && requested.supportsModel && !routeSupportsSelectedEffort(requested, input.profile)) {
      return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.effortChannelUnavailable };
    }
    return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
  }

  if (input.profile.family === 'cursor' && providerAdmitted) {
    return { ok: true, route: 'provider_new_top_level' };
  }
  if (input.profile.family === 'opencode' && providerAdmitted) {
    return { ok: true, route: 'provider_new_top_level' };
  }
  if (exactAdmitted) return { ok: true, route: 'exact_terminal_worktree' };

  const effortMissing = [input.edgeCapabilities.provider, input.edgeCapabilities.exactTerminal]
    .some((capability) => capability.available && capability.supportsModel && !routeSupportsSelectedEffort(capability, input.profile));
  return effortMissing
    ? { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.effortChannelUnavailable }
    : { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
}

export function buildExecutorCommand(profile: SemanticExecutorProfile): ExecutorInvocationShape {
  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS[profile.family];
  if (profile.family === 'cursor') {
    const modelArgument = cursorSpawnModelId(profile);
    const executable = profile.surface === 'task' ? descriptor.taskExecutable : descriptor.smokeExecutable;
    return {
      executable,
      modelArgument,
      command: `${executable} --model ${quote(modelArgument)}`,
    };
  }

  const executable = profile.surface === 'task' ? descriptor.taskExecutable : descriptor.smokeExecutable;
  const inlineConfig = JSON.stringify({ agent: { [OPENCODE_PACK_AGENT]: { model: profile.model, variant: profile.effort } } });
  const command = `OPENCODE_CONFIG_CONTENT=${quote(inlineConfig)} ${executable} --agent ${quote(OPENCODE_PACK_AGENT)}`;
  return {
    executable,
    command,
    agentName: OPENCODE_PACK_AGENT,
    inlineConfigJson: inlineConfig,
  };
}

export interface OpenCodeAgentOverlay {
  readonly agentName: string;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly effort: string;
  readonly stateRoot?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

function configPermissionFromRuleset(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const permission: Record<string, unknown> = {};
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    const item = rule as Record<string, unknown>;
    const name = typeof item.permission === 'string' ? item.permission : '';
    const pattern = typeof item.pattern === 'string' ? item.pattern : '';
    const action = typeof item.action === 'string' ? item.action : '';
    if (!name || !pattern || !action) continue;
    const current = permission[name];
    if (typeof current === 'string') {
      permission[name] = pattern === '*' ? action : { '*': current, [pattern]: action };
    } else if (current && typeof current === 'object' && !Array.isArray(current)) {
      (current as Record<string, unknown>)[pattern] = action;
    } else if (pattern === '*') {
      permission[name] = action;
    } else {
      permission[name] = { [pattern]: action };
    }
  }
  return permission;
}

/** Resolve every OpenCode config location selected by the caller's environment. */
export function openCodeConfigPaths(
  cwd: string,
  configHome: string,
  env: {
    readonly OPENCODE_CONFIG?: string;
    readonly OPENCODE_CONFIG_DIR?: string;
  },
): readonly string[] {
  return [...new Set([
    env.OPENCODE_CONFIG_DIR?.trim() || `${configHome}/opencode`,
    env.OPENCODE_CONFIG?.trim() || '',
    `${cwd}/.opencode`, `${cwd}/opencode.json`, `${cwd}/opencode.jsonc`,
  ].filter(Boolean))];
}

/**
 * Agent.Info is a resolved runtime shape, not a ConfigAgentV1.Info input.
 * Keep only fields accepted by the config schema and translate the resolved
 * camel-case/model-object/permission-ruleset representations.
 */
export function openCodeAgentConfigFromInfo(baseline: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of ['description', 'temperature', 'prompt', 'mode', 'hidden', 'color', 'options']) {
    if (baseline[key] !== undefined) config[key] = baseline[key];
  }
  if (baseline.topP !== undefined) config.top_p = baseline.topP;
  if (baseline.steps !== undefined) config.steps = baseline.steps;
  else if (baseline.maxSteps !== undefined) config.steps = baseline.maxSteps;
  const permission = configPermissionFromRuleset(baseline.permission);
  if (permission) config.permission = permission;
  else if (baseline.permission && typeof baseline.permission === 'object') config.permission = baseline.permission;
  return config;
}

function canonicalPermission(value: unknown): unknown {
  const rules = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([permission, actionOrPatterns]) => typeof actionOrPatterns === 'string'
        ? [{ permission, pattern: '*', action: actionOrPatterns }]
        : actionOrPatterns && typeof actionOrPatterns === 'object' && !Array.isArray(actionOrPatterns)
          ? Object.entries(actionOrPatterns).map(([pattern, action]) => ({ permission, pattern, action }))
          : [])
      : [];
  const last = new Map<string, number>();
  rules.forEach((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return;
    const item = rule as Record<string, unknown>;
    if (typeof item.permission === 'string' && typeof item.pattern === 'string') last.set(`${item.permission}\u0000${item.pattern}`, index);
  });
  return rules.filter((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const item = rule as Record<string, unknown>;
    return last.get(`${item.permission}\u0000${item.pattern}`) === index;
  }).sort((left, right) => {
    const asItem = (value: unknown): Record<string, unknown> => (
      value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    );
    const l = `${String(asItem(left).permission)}\u0000${String(asItem(left).pattern)}`;
    const r = `${String(asItem(right).permission)}\u0000${String(asItem(right).pattern)}`;
    return l.localeCompare(r);
  });
}

/** Compare execution-relevant Agent.Info semantics, not resolved-only metadata. */
export function openCodeAgentSemantics(value: Readonly<Record<string, unknown>>): string {
  const copy: Record<string, unknown> = { ...value, permission: canonicalPermission(value.permission) };
  if (copy.topP === undefined && copy.top_p !== undefined) copy.topP = copy.top_p;
  delete copy.top_p;
  delete copy.name;
  delete copy.native;
  delete copy.tools;
  delete copy.model;
  delete copy.variant;
  return JSON.stringify(stableValue(copy));
}

export function openCodeControlPort(agentName: string): number {
  let hash = 0;
  for (const character of agentName) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return 10_000 + (hash % 50_000);
}

export function buildOpenCodeAgentOverlay(input: OpenCodeAgentOverlay): ExecutorInvocationShape {
  const agent = {
    ...openCodeAgentConfigFromInfo(input.baseline),
    model: input.model,
    variant: input.effort,
  };
  const inlineConfig = JSON.stringify({ agent: { [input.agentName]: agent } });
  const state = input.stateRoot ? ` XDG_STATE_HOME=${quote(input.stateRoot)}` : '';
  const command = `OPENCODE_CONFIG_CONTENT=${quote(inlineConfig)}${state} opencode --hostname 127.0.0.1 --port ${openCodeControlPort(input.agentName)} --agent ${quote(input.agentName)}`;
  return {
    executable: 'opencode',
    command,
    agentName: input.agentName,
    inlineConfigJson: inlineConfig,
  };
}

export function buildProviderInvocation(profile: SemanticExecutorProfile): ProviderInvocationShape | null {
  if (profile.family !== 'cursor') return null;
  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS.cursor;
  return {
    orcaAgent: descriptor.orcaAgent,
    argv: ['--agent', descriptor.orcaAgent, '--model', cursorSpawnModelId(profile)],
  };
}
