import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson, sha256 } from './contract.ts';

export interface CapabilityEvidenceV1 {
  schema:'chatgpt-browser-turn-capability/v1'; candidate_commit:string; executable_digest:string; configured_profile_key:string;
  profile_verification:'verified'|'unavailable'|'mismatch'; product_provenance:string; browser_provenance:string; configuration_digest:string;
  gate_target:string; observed_at:string; expires_at:string; downgrade_generation:number; parallel_eligible:boolean; evidence_digest:string;
}

export interface CapabilityDecision { eligible:boolean; state:'ok'|'no_evidence'|'expired'|'downgraded'|'incompatible_schema'; cause:string; evidence?:CapabilityEvidenceV1; }

export function evidenceDigest(e: Omit<CapabilityEvidenceV1,'evidence_digest'>): string { return sha256(canonicalJson(e)); }

export function validateCapability(value:unknown, expected:{candidateCommit:string;executableDigest:string;profileKey:string;configurationDigest:string;gateTarget:string;downgradeGeneration:number;now?:Date}): CapabilityDecision {
  if (!value || typeof value!=='object') return {eligible:false,state:'incompatible_schema',cause:'capability_not_object'};
  const e=value as CapabilityEvidenceV1;
  if (e.schema!=='chatgpt-browser-turn-capability/v1') return {eligible:false,state:'incompatible_schema',cause:'capability_schema'};
  const clone={...e} as Record<string,unknown>; delete clone.evidence_digest;
  if (sha256(canonicalJson(clone))!==e.evidence_digest) return {eligible:false,state:'downgraded',cause:'capability_tampered',evidence:e};
  if (e.candidate_commit!==expected.candidateCommit || e.executable_digest!==expected.executableDigest || e.configured_profile_key!==expected.profileKey || e.configuration_digest!==expected.configurationDigest || e.gate_target!==expected.gateTarget) return {eligible:false,state:'downgraded',cause:'capability_binding_mismatch',evidence:e};
  if (e.profile_verification!=='verified' || !e.parallel_eligible) return {eligible:false,state:'downgraded',cause:'capability_negative',evidence:e};
  if (e.downgrade_generation!==expected.downgradeGeneration) return {eligible:false,state:'downgraded',cause:'downgrade_generation_changed',evidence:e};
  const now=(expected.now??new Date()).getTime(); const obs=Date.parse(e.observed_at); const exp=Date.parse(e.expires_at);
  if (!Number.isFinite(obs)||!Number.isFinite(exp)||obs>now+60_000||exp<=now||exp-obs>86_400_000) return {eligible:false,state:'expired',cause:'capability_time_invalid',evidence:e};
  return {eligible:true,state:'ok',cause:'capability_current',evidence:e};
}

export function readCapabilityFile(path:string|undefined, expected:Parameters<typeof validateCapability>[1]): CapabilityDecision {
  if (!path || !existsSync(path)) return {eligible:false,state:'no_evidence',cause:'capability_missing'};
  try { return validateCapability(JSON.parse(readFileSync(path,'utf8')),expected); } catch { return {eligible:false,state:'incompatible_schema',cause:'capability_parse_failed'}; }
}
