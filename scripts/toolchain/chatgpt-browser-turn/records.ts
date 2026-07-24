import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertBodyFree, canonicalJson, sha256, type OuterRecordV1, type PublicationStatusV1, publicationStatus } from './contract.ts';

export const RECORD_SCHEMA = 'chatgpt-browser-turn-record/v1' as const;
export const CAPABILITY_SCHEMA = 'chatgpt-browser-turn-capability/v1' as const;

export function defaultStateRoot(): string {
  return resolve(process.env.OPK_CHATGPT_BROWSER_TURN_STATE_ROOT || join(homedir(), '.local', 'state', 'orchestrator-pack', 'chatgpt-browser-turn'));
}

export function configuredProfileKey(profilePath: string, cdpEndpoint: string): string {
  const normalizedProfile = process.platform === 'win32' ? resolve(profilePath).toLowerCase() : resolve(profilePath);
  let endpoint: string;
  try {
    const u = new URL(cdpEndpoint);
    u.hash = ''; u.search = '';
    endpoint = u.toString().replace(/\/$/,'').toLowerCase();
  } catch { endpoint = cdpEndpoint.trim().toLowerCase(); }
  return `profile:${sha256(`${normalizedProfile}\n${endpoint}`)}`;
}

function recordDir(root: string): string { return join(root, 'records'); }
function recordPath(root: string, id: string): string { return join(recordDir(root), `${id}.json`); }

export interface RecordPayload {
  schema: typeof RECORD_SCHEMA;
  producer_commit: string;
  executable_digest: string;
  generation: number;
  incident_id?: string;
  invocation_id?: string;
  created_at: string;
  updated_at: string;
  phase?: string;
  possible_delivery?: boolean;
  evidence_digest?: string;
  [key: string]: unknown;
}

export interface StoredRecord extends OuterRecordV1 { payload: RecordPayload; }

export function writeRecordAtomic(root: string, id: string, record: StoredRecord): void {
  assertBodyFree(record);
  mkdirSync(recordDir(root), { recursive: true, mode: 0o700 });
  const dest = recordPath(root,id);
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${canonicalJson(record)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp,dest);
}

export function readRawRecord(root: string, id: string): { raw: Buffer; parsed?: unknown } {
  const raw = readFileSync(recordPath(root,id));
  try { return { raw, parsed: JSON.parse(raw.toString('utf8')) }; } catch { return { raw }; }
}

export function parseCompatibleRecord(value: unknown): StoredRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.record_kind !== 'string' || typeof r.configured_profile_key !== 'string' || typeof r.blocking_domain_key !== 'string' || !r.payload || typeof r.payload !== 'object') return null;
  const payload = r.payload as Record<string, unknown>;
  if (payload.schema !== RECORD_SCHEMA || typeof payload.generation !== 'number') return null;
  return value as StoredRecord;
}

export interface DiscoveryResult { complete: boolean; compatible: Array<{id:string;record:StoredRecord}>; incompatible: Array<{id:string;raw_sha256:string}>; }

export function discoverRecords(root: string, profileKey: string): DiscoveryResult {
  const dir = recordDir(root);
  if (!existsSync(dir)) return { complete:true, compatible:[], incompatible:[] };
  const compatible: DiscoveryResult['compatible'] = [];
  const incompatible: DiscoveryResult['incompatible'] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0,-5);
    const { raw, parsed } = readRawRecord(root,id);
    if (!parsed || typeof parsed !== 'object') { incompatible.push({id,raw_sha256:sha256(raw)}); continue; }
    const outer = parsed as Record<string, unknown>;
    if (outer.configured_profile_key !== profileKey) continue;
    const rec = parseCompatibleRecord(parsed);
    if (!rec) incompatible.push({id,raw_sha256:sha256(raw)}); else compatible.push({id,record:rec});
  }
  return { complete: incompatible.length === 0, compatible, incompatible };
}

export interface ProfileReservation { dir: string; ownerFile: string; release(): void; }

export function acquireProfileReservation(root: string, profileKey: string, invocationId: string): ProfileReservation | null {
  const locks = join(root,'profile-reservations');
  mkdirSync(locks,{recursive:true,mode:0o700});
  const dir = join(locks,sha256(profileKey));
  try { mkdirSync(dir,{mode:0o700}); } catch { return null; }
  const ownerFile = join(dir,'owner.json');
  const owner = { schema:'profile-reservation/v1', configured_profile_key:profileKey, invocation_id:invocationId, pid:process.pid, acquired_at:new Date().toISOString() };
  assertBodyFree(owner);
  writeFileSync(ownerFile,`${canonicalJson(owner)}\n`,{mode:0o600,flag:'wx'});
  return { dir, ownerFile, release(){ rmSync(dir,{recursive:true,force:true}); } };
}

export interface PublicationRecordInit {
  invocationId:string; profileKey:string; destinationKey:string; finalPath:string; tempPath:string;
  producerCommit:string; executableDigest:string;
}

export function preparePublication(root:string, init:PublicationRecordInit): string {
  const temp = lstatSync(init.tempPath,{bigint:true});
  const now = new Date().toISOString();
  const id = `publication-${init.invocationId}`;
  const record: StoredRecord = {
    record_kind:'publication', configured_profile_key:init.profileKey, blocking_domain_key:init.destinationKey,
    payload:{ schema:RECORD_SCHEMA, producer_commit:init.producerCommit, executable_digest:init.executableDigest,
      generation:1, invocation_id:init.invocationId, created_at:now, updated_at:now, phase:'prepared', possible_delivery:false,
      destination_key:init.destinationKey, final_path:init.finalPath, temp_path:init.tempPath,
      temp_dev:String(temp.dev), temp_ino:String(temp.ino), temp_size:String(temp.size) }
  };
  writeRecordAtomic(root,id,record); return id;
}

export function updatePublication(root:string,id:string, mutator:(record:StoredRecord)=>StoredRecord): StoredRecord {
  const got=readRawRecord(root,id); const current=parseCompatibleRecord(got.parsed);
  if (!current || current.record_kind !== 'publication') throw new Error('publication record incompatible');
  const next=mutator(structuredClone(current)); next.payload.updated_at=new Date().toISOString(); next.payload.generation += 1;
  writeRecordAtomic(root,id,next); return next;
}

function inodeMatches(path:string, dev:unknown, ino:unknown): boolean {
  try { const s=lstatSync(path,{bigint:true}); return String(s.dev)===String(dev) && String(s.ino)===String(ino); } catch { return false; }
}

export function queryPublication(root:string, invocationId:string, profileKey:string, destinationKey:string): PublicationStatusV1 {
  const id=`publication-${invocationId}`; const path=recordPath(root,id);
  if (!existsSync(path)) return publicationStatus({state:'not_committed',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey});
  const {parsed}=readRawRecord(root,id); const rec=parseCompatibleRecord(parsed);
  if (!rec || rec.record_kind!=='publication') return publicationStatus({state:'incompatible_schema',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,cause:'publication_record_incompatible'});
  if (rec.configured_profile_key!==profileKey || rec.blocking_domain_key!==destinationKey) return publicationStatus({state:'conflict',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,cause:'publication_binding_mismatch'});
  const p=rec.payload; const finalPath=String(p.final_path||''); const tempPath=String(p.temp_path||'');
  const finalIsExactTemp=finalPath && inodeMatches(finalPath,p.temp_dev,p.temp_ino);
  const tempStillExact=tempPath && inodeMatches(tempPath,p.temp_dev,p.temp_ino);
  if (finalIsExactTemp) {
    const s=statSync(finalPath); const bytes=readFileSync(finalPath);
    return publicationStatus({state:'committed_ok',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,output:{byte_length:s.size,sha256:sha256(bytes)}});
  }
  if (existsSync(finalPath)) return publicationStatus({state:'conflict',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,cause:'destination_not_invocation_temp'});
  if (tempStillExact) return publicationStatus({state:p.possible_delivery?'recovery_required':'in_progress',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,cause:p.possible_delivery?'delivery_without_commit':'publication_prepared'});
  return publicationStatus({state:p.possible_delivery?'recovery_required':'not_committed',invocation_id:invocationId,configured_profile_key:profileKey,destination_key:destinationKey,cause:'publication_identity_missing'});
}

export function removeRecord(root:string,id:string): void { rmSync(recordPath(root,id),{force:true}); }
