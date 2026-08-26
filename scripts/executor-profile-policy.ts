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
}

export interface SemanticExecutorProfile {
  readonly family: ExecutorFamily;
  readonly surface: ExecutorProfileSurface;
  readonly model: string;
  readonly effort: string;
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

export interface ExecutorInvocationShape {
  readonly executable: string;
  readonly command: string;
  readonly modelArgument: string;
  readonly effortArgument?: string;
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
      ['orca', 'orchestration', 'worker-start', '--help'],
      ['opencode', '--help'],
      ['opencode', 'run', '--help'],
      ['opencode', 'debug', '--help'],
      ['opencode', 'debug', 'agent', '--help'],
      ['opencode', 'debug', 'config', '--help'],
    ],
    smokeCapabilityProbeCommands: [
      ['opencode', '--help'],
      ['opencode', 'debug', 'agent', '--help'],
      ['opencode', 'debug', 'config', '--help'],
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

// The current smoke runtime lifecycle has a Cursor-specific startup witness. Until
// an allowed, freshly evidenced runtime change proves an OpenCode startup shape,
// OpenCode smoke remains externally gated even when its CLI exposes model+effort.
export const OPENCODE_SMOKE_RUNTIME_CAPABILITY: RouteCapability = {
  available: false,
  supportsModel: false,
  supportsEffort: false,
};

const PROFILE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u;
const MODEL_TOKEN_CLASS = 'A-Za-z0-9._:/+-';

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  return {
    ok: true,
    profile: {
      family: descriptor.family,
      surface: input.surface,
      model: values[1],
      effort: values[2],
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

export function executorCatalogContains(profile: SemanticExecutorProfile, output: string): boolean {
  const identity = catalogIdentityForProfile(profile);
  if (!identity || !PROFILE_VALUE_PATTERN.test(identity)) return false;
  const pattern = new RegExp(`(^|[^${MODEL_TOKEN_CLASS}])${regexEscape(identity)}(?=$|[^${MODEL_TOKEN_CLASS}])`, 'mu');
  return pattern.test(output);
}

export function openCodeTuiCapability(tuiHelp: string): RouteCapability {
  const tuiHasModel = /(^|\s)--model(?:[=\s,]|$)/mu.test(tuiHelp);
  const tuiHasVariant = /(^|\s)--variant(?:[=\s,]|$)/mu.test(tuiHelp);
  return {
    available: tuiHasModel,
    supportsModel: tuiHasModel,
    supportsEffort: tuiHasVariant,
  };
}

export function openCodeEdgeCapabilities(probeOutputs: readonly string[]): ExecutorEdgeCapabilities {
  // capabilityProbeCommands fixes the TUI help observation at index 1.
  const exactTerminal = openCodeTuiCapability(probeOutputs[1] ?? '');

  // The provider path stays closed in this package revision unless the downstream
  // supervised-start validator is changed from fresh implementation-time evidence.
  // Merely observing provider help is intentionally not enough to authorize it.
  return {
    provider: { available: false, supportsModel: false, supportsEffort: false },
    exactTerminal,
  };
}

export function evaluateExecutorSpawnApplicability(capability: RouteCapability): SpawnApplicabilityVerdict {
  if (capability.available && capability.supportsModel && capability.supportsEffort) return { ok: true };
  if (capability.available && capability.supportsModel && !capability.supportsEffort) {
    return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.effortChannelUnavailable };
  }
  return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
}

export function evaluateOpenCodeSmokeApplicability(
  observedTuiCapability: RouteCapability,
): SpawnApplicabilityVerdict {
  const tui = evaluateExecutorSpawnApplicability(observedTuiCapability);
  if (!tui.ok) return tui;
  return evaluateExecutorSpawnApplicability(OPENCODE_SMOKE_RUNTIME_CAPABILITY);
}

function routeCapability(capabilities: ExecutorEdgeCapabilities, route: ExecutorRoute): RouteCapability {
  return route === 'provider_new_top_level' ? capabilities.provider : capabilities.exactTerminal;
}

function routeAdmitted(capability: RouteCapability): boolean {
  return capability.available && capability.supportsModel && capability.supportsEffort;
}

export function evaluateExecutorRouteAdmission(input: {
  readonly profile: SemanticExecutorProfile;
  readonly startMode?: ExecutorRoute;
  readonly edgeCapabilities: ExecutorEdgeCapabilities;
}): RouteAdmissionVerdict {
  const providerAdmitted = routeAdmitted(input.edgeCapabilities.provider);
  const exactAdmitted = routeAdmitted(input.edgeCapabilities.exactTerminal);

  if (input.startMode) {
    const requested = routeCapability(input.edgeCapabilities, input.startMode);
    if (routeAdmitted(requested)) return { ok: true, route: input.startMode };
    if (providerAdmitted || exactAdmitted) return { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeMismatch };
    if (requested.available && requested.supportsModel && !requested.supportsEffort) {
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
    .some((capability) => capability.available && capability.supportsModel && !capability.supportsEffort);
  return effortMissing
    ? { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.effortChannelUnavailable }
    : { ok: false, refusal: EXECUTOR_PROFILE_REFUSAL.routeUnavailable };
}

export function buildExecutorCommand(profile: SemanticExecutorProfile): ExecutorInvocationShape {
  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS[profile.family];
  if (profile.family === 'cursor') {
    const modelArgument = cursorOpaqueModelId(profile);
    const executable = profile.surface === 'task' ? descriptor.taskExecutable : descriptor.smokeExecutable;
    return {
      executable,
      modelArgument,
      command: `${executable} --model ${quote(modelArgument)}`,
    };
  }

  const executable = profile.surface === 'task' ? descriptor.taskExecutable : descriptor.smokeExecutable;
  return {
    executable,
    modelArgument: profile.model,
    effortArgument: profile.effort,
    command: `${executable} --model ${quote(profile.model)} --variant ${quote(profile.effort)}`,
  };
}

export function buildProviderInvocation(profile: SemanticExecutorProfile): ProviderInvocationShape | null {
  if (profile.family !== 'cursor') return null;
  const descriptor = EXECUTOR_FAMILY_DESCRIPTORS.cursor;
  return {
    orcaAgent: descriptor.orcaAgent,
    argv: ['--agent', descriptor.orcaAgent, '--model', cursorOpaqueModelId(profile)],
  };
}
