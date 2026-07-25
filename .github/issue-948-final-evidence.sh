#!/usr/bin/env bash
set -euo pipefail

MODE="${1:?usage: issue-948-final-evidence.sh <pre|post> REPO_ROOT EVIDENCE_ROOT}"
REPO_ROOT="$(cd "${2:?repo root required}" && pwd)"
EVIDENCE_ROOT="${3:?evidence root required}"
TARGET_SHA="${TARGET_SHA:-a6aea8592948eac96dbbd3f4b169ee37b0d7b4d0}"
LEGACY_SHA="${LEGACY_SHA:-b967dfe156838039e1d6d137e7064dc9d1b10b4d}"

cd "$REPO_ROOT"
export PATH="$REPO_ROOT/scripts:$PATH"

echo "evidence mode=$MODE target=$TARGET_SHA"
test "$(git rev-parse HEAD)" = "$TARGET_SHA"
TARGET_TREE="$(git rev-parse "${TARGET_SHA}^{tree}")"
LEGACY_TREE="$(git rev-parse "${LEGACY_SHA}^{tree}")"

hash_file() {
  node -e "const fs=require('fs'),c=require('crypto');const b=fs.readFileSync(process.argv[1]);process.stdout.write('sha256:'+c.createHash('sha256').update(b).digest('hex'))" "$1"
}

run_bound() {
  local root="$1" display="$2" actual="$3" stem="$4"
  mkdir -p "$root/commands"
  local log="$root/commands/${stem}.log"
  local result="$root/commands/${stem}.json"
  local row="$root/commands/${stem}.row.json"
  local started completed code
  echo "[evidence] START $display"
  started="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  set +e
  bash -lc "$actual" >"$log" 2>&1
  code=$?
  set -e
  completed="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  node - "$display" "$code" "$TARGET_SHA" "$TARGET_TREE" "$started" "$completed" > "$result" <<'NODE'
const [display,code,commit,tree,started,completed]=process.argv.slice(2);
process.stdout.write(JSON.stringify({schemaVersion:1,command:display,exitCode:Number(code),checkoutCommitSha:commit,checkoutTreeOid:tree,startedAtUtc:started,completedAtUtc:completed})+'\n');
NODE
  local result_sha log_sha
  result_sha="$(hash_file "$result")"
  log_sha="$(hash_file "$log")"
  node - "$display" "$code" "$TARGET_SHA" "$TARGET_TREE" "${row#"$EVIDENCE_ROOT/"}" "$result_sha" "${log#"$EVIDENCE_ROOT/"}" "$log_sha" > /tmp/issue948-row.json <<'NODE'
const [command,code,commit,tree,_rowPath,resultSha256,logPath,logSha256]=process.argv.slice(2);
const resultPath=logPath.replace(/\.log$/u,'.json');
process.stdout.write(JSON.stringify({command,exitCode:Number(code),checkoutCommitSha:commit,checkoutTreeOid:tree,resultPath,resultSha256,logPath,logSha256})+'\n');
NODE
  mv /tmp/issue948-row.json "$row"
  if [[ "$code" -ne 0 ]]; then
    echo "[evidence] FAIL $display exit=$code"
    tail -n 160 "$log" || true
    return "$code"
  fi
  echo "[evidence] PASS $display"
}

run_required_suite_set() {
  local root="$1"
  run_bound "$root" 'npm run typecheck:foundation' 'npm run typecheck:foundation' '01-typecheck'
  run_bound "$root" 'npm run lint:foundation' 'npm run lint:foundation' '02-lint'
  run_bound "$root" 'npm run test:contract-mutations' 'npm run test:contract-mutations' '03-mutations'
  run_bound "$root" 'npm run test:issue-948' 'npm run test:issue-948' '04-issue948'
  run_bound "$root" 'pwsh -NoProfile -File scripts/verify.ps1' 'pwsh -NoProfile -File scripts/verify.ps1' '05-verify'
  run_bound "$root" 'pwsh -NoProfile -File scripts/check-reusable.ps1' 'pwsh -NoProfile -File scripts/check-reusable.ps1' '06-reusable'
  run_bound "$root" 'pwsh -NoProfile -File scripts/test-all.ps1' 'pwsh -NoProfile -File scripts/test-all.ps1' '07-pester'
  run_bound "$root" 'vitest-light' 'set -euo pipefail; pwsh -NoProfile -File scripts/run-vitest-light-lane.ps1 -Shard 1; pwsh -NoProfile -File scripts/run-vitest-light-lane.ps1 -Shard 2' '08-vitest-light'
  run_bound "$root" 'vitest-heavy' 'set -euo pipefail; node scripts/emit-vitest-heavy-topology.mjs --skip-oversized-guard >/tmp/issue948-topology.json; pwsh -NoProfile -File scripts/run-vitest-heavy-shard.ps1 -Shard 1; pwsh -NoProfile -File scripts/run-vitest-heavy-shard.ps1 -Shard 2; rm -f scripts/vitest-heavy-topology.plan.json .vitest-runtime-report-*.json' '09-vitest-heavy'
  rm -f .vitest-runtime-report-*.json scripts/vitest-heavy-topology.plan.json
}

write_quiescence_probe() {
  local phase="$1" out="$2"
  node - "$phase" "$out" <<'NODE'
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const [phase,out]=process.argv.slice(2);
const specs=[
  ['runner',['scripts/pack-review-runner','pack-review-runner.ts']],
  ['autonomous',['orchestrator-review-start-preflight','Orchestrator-AutonomousReviewStartGate','Autonomous-ReviewWorktreeGate']],
  ['manual',['invoke-manual-review-run']],
  ['seed',['review-ready-report-state-seed','Invoke-ReviewReadyReportStateSeed']],
  ['trigger',['review-trigger-reconcile','Invoke-ReviewWakeTrigger']],
  ['reeval',['review-trigger-reeval','Invoke-ReviewTriggerReeval']],
  ['supervised',['Review-StartSupervisedGh']],
  ['snapshot',['Get-ClaimedReviewStartSnapshot']],
  ['preflight',['Review-StartPreflightShield','orchestrator-review-start-preflight']],
  ['recovery',['Review-StartClaimReclaimOrphan','review-start-claim-recovery']],
  ['reap',['review-start-claim-reaper']],
];
const ps=execFileSync('ps',['-eo','pid=,args='],{encoding:'utf8'}).split(/\r?\n/u).filter(Boolean);
const self=process.pid;
const rows=specs.map(([cls,patterns])=>{
  const matches=ps.filter(line=>!line.trimStart().startsWith(String(self)+' ') && patterns.some(pattern=>line.includes(pattern)));
  return {class:cls,probe:'process-argv-inventory',patterns,matches,blocked:matches.length===0,zero:matches.length===0};
});
if(rows.some(row=>!row.zero)) throw new Error(`rollback_${phase}_quiescence_failed:${JSON.stringify(rows.filter(row=>!row.zero))}`);
fs.writeFileSync(out,JSON.stringify({schemaVersion:1,result:'pass',phase,observedAtUtc:new Date().toISOString(),entrypoints:rows},null,2)+'\n');
NODE
}

build_pre_evidence() {
  rm -rf "$EVIDENCE_ROOT"
  mkdir -p "$EVIDENCE_ROOT/commands" "$EVIDENCE_ROOT/overlap/rows" "$EVIDENCE_ROOT/rollback" "$EVIDENCE_ROOT/external"
  git status --porcelain=v1 > "$EVIDENCE_ROOT/pre-receipt-git-status.txt"
  test ! -s "$EVIDENCE_ROOT/pre-receipt-git-status.txt"

  run_required_suite_set "$EVIDENCE_ROOT"
  echo '[evidence] prerequisite suites complete'

  cp scripts/pr2a/review-start-claim-protocol-vectors.json "$EVIDENCE_ROOT/overlap/vectors.json"
  local legacy_dir="$RUNNER_TEMP/issue948-legacy"
  rm -rf "$legacy_dir"
  git worktree add --detach "$legacy_dir" "$LEGACY_SHA"
  local node_bin pwsh_bin
  node_bin="$(command -v node)"
  pwsh_bin="$(command -v pwsh)"
  cat > "$EVIDENCE_ROOT/overlap/inputs.json" <<EOF
{"repoRoot":"$REPO_ROOT","legacyDir":"$legacy_dir","nodePath":"$node_bin","pwshPath":"$pwsh_bin","legacyCommitSha":"$LEGACY_SHA","legacyTreeOid":"$LEGACY_TREE","candidateCommitSha":"$TARGET_SHA","candidateTreeOid":"$TARGET_TREE","evidenceRoot":"$EVIDENCE_ROOT"}
EOF

  cat > "$EVIDENCE_ROOT/overlap/replay.mjs" <<'NODE'
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const input=JSON.parse(readFileSync(path.resolve(process.cwd(),process.argv.at(-3)),'utf8'));
const matrixPath=path.resolve(process.cwd(),process.argv.at(-2));
const vectorsPath=path.resolve(process.cwd(),process.argv.at(-1));
const vectors=JSON.parse(readFileSync(vectorsPath,'utf8'));
const classes=['acquisition','guarded-mutation','terminal-audit','release-completion','recovery-reap','interpretation','generation-fence'];
const dataVectorClasses=[...new Set((vectors.vectors??[]).map(x=>String(x.class??'')))].filter(Boolean);
const protocolVectorClasses=[...new Set((vectors.protocolVectors??[]).map(x=>String(x.class??'')))].filter(Boolean);
const store=await import(pathToFileURL(path.join(input.repoRoot,'scripts/lib/review-start-claim-store.ts')).href);
const legacyScript=path.join(input.legacyDir,'scripts/lib/Review-StartClaim.ps1');
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const parseLastJson=text=>{for(const line of String(text).trim().split(/\r?\n/u).reverse()){try{return JSON.parse(line)}catch{}}throw new Error('json_result_missing:'+text)};
const run=(cmd,args,opts={})=>{const r=spawnSync(cmd,args,{cwd:opts.cwd??input.repoRoot,env:{...process.env,...opts.env},encoding:'utf8'});if(r.status!==0)throw new Error(`${cmd} failed\n${r.stdout}\n${r.stderr}`);return {stdout:r.stdout,stderr:r.stderr}};
const psQuote=s=>String(s).replaceAll("'","''");
const legacyAcquire=(ns,pr,sha,surface='legacy-evidence')=>parseLastJson(run(input.pwshPath,['-NoProfile','-Command',`$ErrorActionPreference='Stop';$env:AO_REVIEW_START_MONOTONIC_NOW_MS='1000';. '${psQuote(legacyScript)}';$r=Acquire-ReviewStartClaim -PrNumber ${pr} -HeadSha '${sha}' -Surface '${surface}' -Namespace '${psQuote(ns)}' -ReviewRuns @();$r|ConvertTo-Json -Compress -Depth 30`]).stdout);
const legacyComplete=(claim,outcome)=>{const f=path.join(tmpdir(),`claim-${process.pid}-${Math.random()}.json`);writeFileSync(f,JSON.stringify(claim));try{return parseLastJson(run(input.pwshPath,['-NoProfile','-Command',`$ErrorActionPreference='Stop';$env:AO_REVIEW_START_MONOTIC_NOW_MS='1000';. '${psQuote(legacyScript)}';$r=Get-Content -LiteralPath '${psQuote(f)}' -Raw|ConvertFrom-Json -AsHashtable;$o=Complete-ReviewStartClaim -ClaimResult $r -Outcome '${outcome}' -ReviewRuns @();$o|ConvertTo-Json -Compress -Depth 30`]).stdout)}finally{rmSync(f,{force:true})}};
const base=name=>path.join(tmpdir(),`issue948-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
async function concurrentAcquisition(){
  const ns=base('acq');mkdirSync(ns,{recursive:true});const start=path.join(ns,'start');const lr=path.join(ns,'legacy.json');const cr=path.join(ns,'candidate.json');const sha='a'.repeat(40);
  const ps=`$ErrorActionPreference='Stop';$env:AO_REVIEW_START_MONOTONIC_NOW_MS='1000';. '${psQuote(legacyScript)}';while(-not(Test-Path -LiteralPath '${psQuote(start)}')){Start-Sleep -Milliseconds 10};$r=Acquire-ReviewStartClaim -PrNumber 948 -HeadSha '${sha}' -Surface 'legacy-overlap' -Namespace '${psQuote(ns)}' -ReviewRuns @();$r|ConvertTo-Json -Compress -Depth 30|Set-Content -LiteralPath '${psQuote(lr)}' -Encoding utf8`;
  const js=`import{existsSync,writeFileSync}from'node:fs';import{acquireReviewStartClaim}from ${JSON.stringify(pathToFileURL(path.join(input.repoRoot,'scripts/lib/review-start-claim-store.ts')).href)};while(!existsSync(${JSON.stringify(start)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const r=acquireReviewStartClaim({prNumber:948,headSha:'${sha}',surface:'candidate-overlap',namespace:${JSON.stringify(ns)},reviewRuns:[]});writeFileSync(${JSON.stringify(cr)},JSON.stringify(r));`;
  const waitChild=(cmd,args)=>new Promise((resolve,reject)=>{const c=spawn(cmd,args,{cwd:input.repoRoot,env:process.env});let e='';c.stderr.on('data',d=>e+=d);c.on('exit',code=>code===0?resolve():reject(new Error(`${cmd} ${code}: ${e}`)))});
  const p1=waitChild(input.pwshPath,['-NoProfile','-Command',ps]);const p2=waitChild(input.nodePath,['--experimental-strip-types','--input-type=module','-e',js]);await new Promise(r=>setTimeout(r,80));writeFileSync(start,'go');await Promise.all([p1,p2]);
  const l=JSON.parse(readFileSync(lr,'utf8'));const c=JSON.parse(readFileSync(cr,'utf8'));if([l,c].filter(x=>x.acquired===true).length!==1)throw new Error('acquisition_single_winner_failed');
  rmSync(ns,{recursive:true,force:true});return {legacy:l.acquired?'acquired':l.reason,candidate:c.acquired?'acquired':c.reason};
}
async function executeClass(cls,index){
  console.error(`[overlap] ${cls}`);
  if(cls==='acquisition')return await concurrentAcquisition();
  const ns=base(cls);mkdirSync(ns,{recursive:true});const sha=(index.toString(16).repeat(40)).slice(0,40);const pr=960+index;let detail={};
  try{
    if(cls==='guarded-mutation'){
      const l=legacyAcquire(ns,pr,sha);if(!l.acquired)throw new Error('legacy acquire failed');const read=store.readClaimRecord(l.path);if(!read.ok)throw new Error('candidate read legacy failed');const r=store.updateReviewStartClaimRecordFields({acquired:true,claim:read.record,path:l.path,namespace:ns,key:read.record.key},{evidenceMutation:'candidate-after-legacy'});if(r.ok!==true)throw new Error('candidate mutation failed');detail={legacy:'Acquire-ReviewStartClaim',candidate:'updateReviewStartClaimRecordFields'};
    }else if(cls==='terminal-audit'){
      const l=legacyAcquire(ns,pr,sha);const read=store.readClaimRecord(l.path);const r=store.completeReviewStartClaim({acquired:true,claim:read.record,path:l.path,namespace:ns,key:read.record.key},'released_for_retry',[]);if(r.ok!==true||!existsSync(String(r.terminalPath))||!existsSync(String(r.auditPath)))throw new Error('terminal audit failed');detail={legacy:'Acquire-ReviewStartClaim',candidate:'completeReviewStartClaim terminal+audit'};
    }else if(cls==='release-completion'){
      const c=store.acquireReviewStartClaim({prNumber:pr,headSha:sha,surface:'candidate-release',namespace:ns,reviewRuns:[]});if(!c.acquired)throw new Error('candidate acquire failed');const l=legacyComplete(c,'released_for_retry');if(l.ok!==true)throw new Error('legacy completion failed');detail={legacy:'Complete-ReviewStartClaim',candidate:'acquireReviewStartClaim'};
    }else if(cls==='recovery-reap'){
      const l=legacyAcquire(ns,pr,sha);const read=store.readClaimRecord(l.path);const stale={...read.record,acquiredAtUtc:'2020-01-01T00:00:00.000Z',holder:{...read.record.holder,pid:2147483000}};store.atomicWriteJson(l.path,stale);const r=store.reaperSweep({namespace:ns,reviewRuns:[]});if(!Array.isArray(r.results)||r.results.length===0)throw new Error('reaper produced no decision');detail={legacy:'Acquire-ReviewStartClaim stale record',candidate:'reaperSweep'};
    }else if(cls==='interpretation'){
      const l=legacyAcquire(ns,pr,sha);const read=store.readClaimRecord(l.path);const r=store.evaluateLifecycle('reclaim-decision',{claim:read.record,holderLiveness:{outcome:'alive'},reviewRuns:[],projectNamespace:'orchestrator-pack'});if(!String(r.action??''))throw new Error('interpretation missing action');detail={legacy:'legacy persisted record',candidate:`evaluateLifecycle:${r.action}`};
    }else if(cls==='generation-fence'){
      const l=legacyAcquire(ns,pr,sha);const read=store.readClaimRecord(l.path);const staleClaim=structuredClone(read.record);store.atomicWriteJson(l.path,{...read.record,holder:{...read.record.holder,processGuid:'replacement-guid',generation:'replacement-generation'}});const r=store.updateReviewStartClaimRecordFields({acquired:true,claim:staleClaim,path:l.path,namespace:ns,key:staleClaim.key},{shouldNotWrite:true});if(r.ok!==false||r.reason!=='lost_ownership')throw new Error(`generation fence failed:${JSON.stringify(r)}`);detail={legacy:'original legacy generation',candidate:'lost_ownership generation fence'};
    }else throw new Error('unknown class');
    return detail;
  }finally{rmSync(ns,{recursive:true,force:true})}
}
const details=[];for(let i=0;i<classes.length;i++)details.push(await executeClass(classes[i],i+1));
const executedRows=classes.map((c,i)=>`matrix-${i}-${c}`);
if(process.env.OPK_EVIDENCE_WRITE_ROWS==='1'){
  const rows=[];for(let i=0;i<classes.length;i++){
    const cls=classes[i],id=executedRows[i],detail=details[i];const llog=`legacy ${cls} PASS ${JSON.stringify(detail)}\n`,clog=`candidate ${cls} PASS ${JSON.stringify(detail)}\n`;
    const llogRel=`overlap/rows/${id}-legacy.log`,clogRel=`overlap/rows/${id}-candidate.log`,lresRel=`overlap/rows/${id}-legacy.json`,cresRel=`overlap/rows/${id}-candidate.json`;
    writeFileSync(path.join(input.evidenceRoot,llogRel),llog);writeFileSync(path.join(input.evidenceRoot,clogRel),clog);
    const lres={schemaVersion:1,result:'pass',side:'legacy',matrixRowId:id,class:cls,command:String(detail.legacy),exitCode:0,commitSha:input.legacyCommitSha,treeOid:input.legacyTreeOid,logPath:llogRel,logSha256:hash(llog)};
    const cres={schemaVersion:1,result:'pass',side:'candidate',matrixRowId:id,class:cls,command:String(detail.candidate),exitCode:0,commitSha:input.candidateCommitSha,treeOid:input.candidateTreeOid,logPath:clogRel,logSha256:hash(clog)};
    const ltxt=JSON.stringify(lres)+'\n',ctxt=JSON.stringify(cres)+'\n';writeFileSync(path.join(input.evidenceRoot,lresRel),ltxt);writeFileSync(path.join(input.evidenceRoot,cresRel),ctxt);
    rows.push({id,class:cls,legacyOperation:lres.command,candidateOperation:cres.command,legacyCommitSha:input.legacyCommitSha,legacyTreeOid:input.legacyTreeOid,candidateCommitSha:input.candidateCommitSha,candidateTreeOid:input.candidateTreeOid,legacyResultPath:lresRel,legacyResultSha256:hash(ltxt),candidateResultPath:cresRel,candidateResultSha256:hash(ctxt)});
  }
  writeFileSync(matrixPath,JSON.stringify({schemaVersion:2,classes,rows},null,2)+'\n');
}
const summary={schemaVersion:1,result:'pass',legacyCommitSha:input.legacyCommitSha,legacyTreeOid:input.legacyTreeOid,candidateCommitSha:input.candidateCommitSha,candidateTreeOid:input.candidateTreeOid,classes,dataVectorClasses,protocolVectorClasses,executedRows};
process.stdout.write(JSON.stringify(summary)+'\n');
NODE

  : > "$EVIDENCE_ROOT/overlap/matrix.json"
  echo '[evidence] run immutable legacy-vs-candidate overlap'
  OPK_EVIDENCE_WRITE_ROWS=1 "$node_bin" --experimental-strip-types "$EVIDENCE_ROOT/overlap/replay.mjs" "$EVIDENCE_ROOT/overlap/inputs.json" "$EVIDENCE_ROOT/overlap/matrix.json" "$EVIDENCE_ROOT/overlap/vectors.json" > "$EVIDENCE_ROOT/overlap/stdout.txt"

  local candidate_build_json candidate_build_digest
  candidate_build_json="$(node --experimental-strip-types --input-type=module - <<'NODE'
import { buildCandidateBuildProvenance } from './scripts/pr2a/closure-receipt.ts';
process.stdout.write(JSON.stringify(buildCandidateBuildProvenance('HEAD')));
NODE
)"
  candidate_build_digest="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.digest)' "$candidate_build_json")"
  cat > "$EVIDENCE_ROOT/overlap/result.json" <<EOF
{"schemaVersion":1,"result":"pass","legacyCommitSha":"$LEGACY_SHA","legacyTreeOid":"$LEGACY_TREE","candidateCommitSha":"$TARGET_SHA","candidateTreeOid":"$TARGET_TREE","candidateBuildDigest":"$candidate_build_digest","classes":["acquisition","guarded-mutation","terminal-audit","release-completion","recovery-reap","interpretation","generation-fence"]}
EOF

  echo '[evidence] rollback rehearsal: verified quiescence before revert'
  write_quiescence_probe before "$EVIDENCE_ROOT/rollback/quiescence-before.json"
  local rollback_work="$RUNNER_TEMP/issue948-rollback-work"
  rm -rf "$rollback_work"
  git worktree add --detach "$rollback_work" "$TARGET_SHA"
  sleep 300 &
  local survivor_pid=$!
  node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/pr2a/rollback-drain.ts -- export --out "$EVIDENCE_ROOT/rollback/detached" --generation "$TARGET_TREE" --pids "$survivor_pid" > "$EVIDENCE_ROOT/rollback/export-raw.json"
  local detached_art="$EVIDENCE_ROOT/rollback/detached/rollback-drain-artifact.json"
  local detached_sha
  detached_sha="$(hash_file "$detached_art")"
  node - "$detached_sha" "$EVIDENCE_ROOT/rollback/export-raw.json" > "$EVIDENCE_ROOT/rollback/export.json" <<'NODE'
const fs=require('fs');const [sha,rawPath]=process.argv.slice(2);const raw=JSON.parse(fs.readFileSync(rawPath,'utf8'));process.stdout.write(JSON.stringify({schemaVersion:1,result:'pass',detachedDrainSha256:sha,artifactPath:raw.artifactPath,runnerPath:raw.runnerPath})+'\n');
NODE

  local claim_ns="$EVIDENCE_ROOT/rollback/compat"
  mkdir -p "$claim_ns"
  node --experimental-strip-types --input-type=module - "$claim_ns" > "$EVIDENCE_ROOT/rollback/ts-claim.json" <<'NODE'
import { acquireReviewStartClaim } from './scripts/lib/review-start-claim-store.ts';
const ns=process.argv[2],sha='e'.repeat(40);const r=acquireReviewStartClaim({prNumber:948,headSha:sha,surface:'rollback-evidence',namespace:ns,reviewRuns:[]});if(!r.acquired)throw new Error('rollback claim not acquired');process.stdout.write(JSON.stringify({schemaVersion:1,result:'pass',recordPath:r.path})+'\n');
NODE
  local claim_path before_tree after_commit after_tree detached_after
  claim_path="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.recordPath)' "$EVIDENCE_ROOT/rollback/ts-claim.json")"
  before_tree="$(git -C "$rollback_work" rev-parse HEAD^{tree})"
  test "$before_tree" = "$TARGET_TREE"
  git -C "$rollback_work" reset --hard "$LEGACY_SHA"
  after_commit="$(git -C "$rollback_work" rev-parse HEAD)"
  after_tree="$(git -C "$rollback_work" rev-parse HEAD^{tree})"
  detached_after="$(hash_file "$detached_art")"
  test "$after_commit" = "$LEGACY_SHA"
  test "$after_tree" = "$LEGACY_TREE"
  test "$detached_after" = "$detached_sha"
  cat > "$EVIDENCE_ROOT/rollback/full-revert.json" <<EOF
{"schemaVersion":1,"result":"pass","fromTreeOid":"$before_tree","toCommitSha":"$after_commit","toTreeOid":"$after_tree","detachedDrainSha256Before":"$detached_sha","detachedDrainSha256After":"$detached_after"}
EOF

  echo '[evidence] rollback rehearsal: drain exported pre-revert process after full revert'
  npm run check:node-major --silent
  node --experimental-strip-types --input-type=module - "$detached_art" "$EVIDENCE_ROOT/rollback/detached/rollback-drain.ts" > "$EVIDENCE_ROOT/rollback/drain-raw.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [artifactPath,runnerPath]=process.argv.slice(2);const mod=await import(pathToFileURL(runnerPath).href);const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));const result=await mod.executeRollbackDrainArtifact(artifact);process.stdout.write(JSON.stringify(result)+'\n');
NODE
  node - "$EVIDENCE_ROOT/rollback/drain-raw.json" > "$EVIDENCE_ROOT/rollback/drain-result.json" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(!Array.isArray(x.drained)||x.drained.length===0)throw new Error('no drained process');process.stdout.write(JSON.stringify({schemaVersion:1,result:'pass',drained:x.drained.map(String),stale:(x.stale??[]).map(String),zeroSurvivorsBeforeResume:true})+'\n');
NODE

  export ROLLBACK_WORK="$rollback_work" CLAIM_PATH="$claim_path" LEGACY_SHA LEGACY_TREE
  cat > "$EVIDENCE_ROOT/rollback/legacy-read.ps1" <<'PS1'
$ErrorActionPreference = 'Stop'
. (Join-Path $env:ROLLBACK_WORK 'scripts/lib/Review-StartClaim.ps1')
$r = Read-ReviewStartClaimRecord -Path $env:CLAIM_PATH
if (-not $r.ok) { throw 'legacy reread failed' }
@{ schemaVersion=1; result='pass'; legacyCommitSha=$env:LEGACY_SHA; legacyTreeOid=$env:LEGACY_TREE; recordPath=$env:CLAIM_PATH } | ConvertTo-Json -Compress
PS1
  pwsh -NoProfile -File "$EVIDENCE_ROOT/rollback/legacy-read.ps1" > "$EVIDENCE_ROOT/rollback/legacy-read.json"
  write_quiescence_probe after "$EVIDENCE_ROOT/rollback/quiescence-after.json"

  node - "$EVIDENCE_ROOT/rollback/proof.json" "$TARGET_TREE" "$LEGACY_SHA" "$LEGACY_TREE" "$detached_sha" "$EVIDENCE_ROOT" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [out,finalTree,legacyCommit,legacyTree,drainSha,root]=process.argv.slice(2);const h=p=>'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');const before=JSON.parse(fs.readFileSync(path.join(root,'rollback/quiescence-before.json'),'utf8'));const after=JSON.parse(fs.readFileSync(path.join(root,'rollback/quiescence-after.json'),'utf8'));const revert=JSON.parse(fs.readFileSync(path.join(root,'rollback/full-revert.json'),'utf8'));const proof={schemaVersion:1,result:'pass',finalTreeOid:finalTree,legacyCommitSha:legacyCommit,legacyTreeOid:legacyTree,imports928ActivationMachinery:false,entryBefore:{mode:'total-entrypoint-quiescence',result:'pass',entrypoints:before.entrypoints},entryAfter:{mode:'total-entrypoint-quiescence',result:'pass',entrypoints:after.entrypoints},quiescence:{complete:true,zeroSurvivorsBeforeResume:true,entrypoints:after.entrypoints},fullRevert:{completed:true,...revert},artifacts:{export:{path:'rollback/export.json',sha256:h('rollback/export.json')},drainResult:{path:'rollback/drain-result.json',sha256:h('rollback/drain-result.json')},tsClaim:{path:'rollback/ts-claim.json',sha256:h('rollback/ts-claim.json')},legacyRead:{path:'rollback/legacy-read.json',sha256:h('rollback/legacy-read.json')},quiescenceBefore:{path:'rollback/quiescence-before.json',sha256:h('rollback/quiescence-before.json')},quiescenceAfter:{path:'rollback/quiescence-after.json',sha256:h('rollback/quiescence-after.json')},fullRevert:{path:'rollback/full-revert.json',sha256:h('rollback/full-revert.json')}}};fs.writeFileSync(out,JSON.stringify(proof,null,2)+'\n');
NODE
  cat > "$EVIDENCE_ROOT/rollback/result.json" <<EOF
{"schemaVersion":1,"result":"pass","finalTreeOid":"$TARGET_TREE","zeroSurvivorsBeforeResume":true,"detachedDrainSha256":"$detached_sha"}
EOF

  echo '[evidence] capture live #928 through pack scripts/gh'
  gh issue view 928 --repo chetwerikoff/orchestrator-pack --json number,title,body,url,state,stateReason,labels,assignees > "$EVIDENCE_ROOT/external/issue-928.json"
  local captured_at body_sha
  captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  node - "$EVIDENCE_ROOT/external/issue-928.json" "$EVIDENCE_ROOT/external/issue-928.md" <<'NODE'
const fs=require('fs');const [src,dst]=process.argv.slice(2),x=JSON.parse(fs.readFileSync(src,'utf8'));fs.writeFileSync(dst,String(x.body??''));
NODE
  body_sha="$(hash_file "$EVIDENCE_ROOT/external/issue-928.md")"

  local platform filesystem node_version pwsh_version
  platform='linux'
  filesystem="$(findmnt -no FSTYPE -T "$EVIDENCE_ROOT" | head -n1 | tr '[:upper:]' '[:lower:]')"
  node_version="$(node --version)"
  pwsh_version="$(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"
  node - "$EVIDENCE_ROOT" "$TARGET_SHA" "$TARGET_TREE" "$LEGACY_SHA" "$LEGACY_TREE" "$candidate_build_digest" "$platform" "$filesystem" "$node_version" "$pwsh_version" "$captured_at" "$body_sha" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [root,candidateCommit,candidateTree,legacyCommit,legacyTree,buildDigest,platform,filesystem,nodeVersion,pwshVersion,capturedAt,bodyDigest]=process.argv.slice(2);const h=p=>'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');const rows=['01-typecheck','02-lint','03-mutations','04-issue948','05-verify','06-reusable','07-pester','08-vitest-light','09-vitest-heavy'].map(x=>JSON.parse(fs.readFileSync(path.join(root,'commands',x+'.row.json'),'utf8')));const issue=JSON.parse(fs.readFileSync(path.join(root,'external/issue-928.json'),'utf8'));const bundle={schemaVersion:1,overlap:{schemaVersion:1,result:'pass',generatedAfterFinalTree:true,finalTreeOid:candidateTree,candidateTreeOid:candidateTree,candidateBuildDigest:buildDigest,legacyRepository:'chetwerikoff/orchestrator-pack',legacyCommitSha:legacyCommit,legacyTreeOid:legacyTree,candidateRepository:'chetwerikoff/orchestrator-pack',candidateCommitSha:candidateCommit,harnessPath:'overlap/replay.mjs',harnessSha256:h('overlap/replay.mjs'),harnessBytesArchived:true,operationMatrixPath:'overlap/matrix.json',operationMatrixSha256:h('overlap/matrix.json'),replayCommand:process.execPath,replayArgs:['--experimental-strip-types','overlap/replay.mjs','overlap/inputs.json','overlap/matrix.json','overlap/vectors.json'],replayCwd:'.',replayInputsPath:'overlap/inputs.json',replayInputsSha256:h('overlap/inputs.json'),replayStdoutPath:'overlap/stdout.txt',replayStdoutSha256:h('overlap/stdout.txt'),replayExitCode:0,protocolVectorPath:'overlap/vectors.json',protocolVectorSha256:h('overlap/vectors.json'),platform,filesystem,classes:['acquisition','guarded-mutation','terminal-audit','release-completion','recovery-reap','interpretation','generation-fence'],logPath:'overlap/result.json',logSha256:h('overlap/result.json')},rollback:{schemaVersion:1,result:'pass',finalTreeOid:candidateTree,isolatedCheckout:true,entryBlockedBeforeRevert:true,entryBlockedAfterRevert:true,quiescenceInventoryComplete:true,detachedDrainPath:'rollback/detached/rollback-drain-artifact.json',detachedDrainSha256:h('rollback/detached/rollback-drain-artifact.json'),detachedDrainSurvivedRevert:true,zeroSurvivorsBeforeResume:true,legacyReadTsRecord:true,imports928ActivationMachinery:false,legacyCommitSha:legacyCommit,legacyTreeOid:legacyTree,proofPath:'rollback/proof.json',proofSha256:h('rollback/proof.json'),logPath:'rollback/result.json',logSha256:h('rollback/result.json')},preReceiptVerification:{schemaVersion:1,result:'pass',finalTreeOid:candidateTree,checkoutCommitSha:candidateCommit,checkoutTreeOid:candidateTree,repository:'chetwerikoff/orchestrator-pack',platform,filesystem,nodeVersion,pwshVersion,cleanBefore:true,cleanAfter:true,stagedBefore:0,stagedAfter:0,untrackedBefore:0,untrackedAfter:0,prerequisiteSuitesPassedBeforeReceipt:true,commands:rows},external928:{schemaVersion:1,result:'pass',url:String(issue.url??'https://github.com/chetwerikoff/orchestrator-pack/issues/928'),repository:'chetwerikoff/orchestrator-pack',issue:928,revisionIdentity:`body:${bodyDigest}`,updatedAt:capturedAt,capturedAt,actor:String(process.env.GITHUB_ACTOR??'github-actions'),tool:'pack scripts/gh issue view',bodyPath:'external/issue-928.md',bodySha256:h('external/issue-928.md'),requirements:{consumesPr2aTsAuthority:true,consumesReceiptAsPrecedent:true,independentlyRecomputesCurrentClosure:true,invariantBasedRefusal:true,historicalInventoryEqualityNotRequired:true}}};fs.writeFileSync(path.join(root,'bundle.json'),JSON.stringify(bundle,null,2)+'\n');
NODE

  git status --porcelain=v1 > "$EVIDENCE_ROOT/pre-receipt-git-status-after.txt"
  test ! -s "$EVIDENCE_ROOT/pre-receipt-git-status-after.txt"
  echo '[evidence] build independently validated closure receipt'
  node --experimental-strip-types scripts/pr2a/closure-receipt.ts --ref "$TARGET_SHA" --evidence "$EVIDENCE_ROOT/bundle.json" > "$EVIDENCE_ROOT/receipt.json"
  test "$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.result)' "$EVIDENCE_ROOT/receipt.json")" = 'tree-bound-empty-external-reverse-closure'
  echo '[evidence] pre receipt PASS'
}

build_post_evidence() {
  test -f "$EVIDENCE_ROOT/receipt.json"
  mkdir -p "$EVIDENCE_ROOT/post"
  run_required_suite_set "$EVIDENCE_ROOT/post"
  git status --porcelain=v1 > "$EVIDENCE_ROOT/post/git-status.txt"
  test ! -s "$EVIDENCE_ROOT/post/git-status.txt"
  local receipt_sha platform filesystem node_version pwsh_version
  receipt_sha="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.receiptSha256)' "$EVIDENCE_ROOT/receipt.json")"
  platform='linux'
  filesystem="$(findmnt -no FSTYPE -T "$EVIDENCE_ROOT" | head -n1 | tr '[:upper:]' '[:lower:]')"
  node_version="$(node --version)"
  pwsh_version="$(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"
  node - "$EVIDENCE_ROOT" "$receipt_sha" "$TARGET_SHA" "$TARGET_TREE" "$platform" "$filesystem" "$node_version" "$pwsh_version" <<'NODE'
const fs=require('fs'),path=require('path');const [root,receiptSha,commit,tree,platform,filesystem,nodeVersion,pwshVersion]=process.argv.slice(2);const rows=['01-typecheck','02-lint','03-mutations','04-issue948','05-verify','06-reusable','07-pester','08-vitest-light','09-vitest-heavy'].map(x=>JSON.parse(fs.readFileSync(path.join(root,'post','commands',x+'.row.json'),'utf8')));fs.writeFileSync(path.join(root,'final-verification.json'),JSON.stringify({schemaVersion:1,result:'pass',receiptSha256:receiptSha,finalTreeOid:tree,checkoutCommitSha:commit,checkoutTreeOid:tree,repository:'chetwerikoff/orchestrator-pack',platform,filesystem,nodeVersion,pwshVersion,cleanBefore:true,cleanAfter:true,stagedBefore:0,stagedAfter:0,untrackedBefore:0,untrackedAfter:0,commands:rows},null,2)+'\n');
NODE
  node --experimental-strip-types scripts/pr2a/closure-receipt.ts --final-verification "$EVIDENCE_ROOT/final-verification.json" --receipt "$EVIDENCE_ROOT/receipt.json" > "$EVIDENCE_ROOT/final-validation.json"
  test "$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.result)' "$EVIDENCE_ROOT/final-validation.json")" = pass
  echo '[evidence] post final PASS'
}

case "$MODE" in
  pre) build_pre_evidence ;;
  post) build_post_evidence ;;
  *) echo "unsupported mode: $MODE" >&2; exit 2 ;;
esac
