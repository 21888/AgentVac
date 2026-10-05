// Research-only direct execution of this tree's freshly source-built helper.
// No production installation receipt is created or consumed by this smoke lane.
import {readFile,lstat,mkdtemp,mkdir,open,unlink,rmdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {canonicalize,encodeRequest,decodeResponse} from '../protocol.mjs';
import {decodeRestricted} from '../restricted-protocol.mjs';
import {smokeObservationStatus,smokeExpectationStatus,smokeIdentityFailureStatus} from '../smoke-results.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const build=path.join(root,'build','windows-x64');
const helper=path.join(build,'agentvac-metadata-research.exe');
const launcher=path.join(build,'agentvac-restricted-fixture-launcher.exe');
const sourceNames=['.gitattributes','include/core.hpp','src/native-helper.cpp','src/restricted-fixture-launcher.cpp','src/helper.manifest','protocol.mjs','restricted-protocol.mjs','smoke-results.mjs','transport.mjs','scripts/build-windows.ps1','scripts/native-smoke.mjs','scripts/source-manifest.mjs'].sort();
const cases=[];
const blocked=Object.freeze(['preprovisioned-broad-acl','owner-variation','deny-ace-variation','null-empty-unknown-acl','reparse-ancestor-and-leaf','subst-and-network-mappings','security-races','system-call-tracing','production-bootstrap','write-containment-lease']);
let evidence={},fixtureRoot,emptyPath;
const hash=b=>createHash('sha256').update(b).digest('hex');
const output=(status,extra={})=>process.stdout.write(JSON.stringify({schema:1,lane:'partial-source-built-native-smoke',status,nativeWindows:process.platform==='win32'?'PARTIAL_ONLY':'NOT_RUN',productionAccepted:false,applicationActivated:false,evidence,cases,unavailableFixtures:blocked,...extra})+'\n');
const observation=(id,result)=>cases.push({id,status:smokeObservationStatus(result.outcome),actual:result.outcome,...(result.reason?{reason:result.reason}:{}),...(result.token?{token:result.token}:{})});
const mark=(id,result,expected)=>{
  const actual=result.outcome;
  cases.push({id,status:smokeExpectationStatus(actual,expected),expected,actual,...(result.reason?{reason:result.reason}:{}),...(result.token?{token:result.token}:{})});
};
const curatedEnv=()=>({SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',SystemDrive:'C:',USERPROFILE:'',APPDATA:'',LOCALAPPDATA:'',TEMP:'',TMP:'',HOMEDRIVE:'',HOMEPATH:'',PATH:''});
async function checkedLaunch(frame,{keepInputOpen=false,cancelAfterMs,timeoutMs=6000,request={mode:'locality',directory:true},restricted=false}={}) {
  // Exact derived binary only; no executable argument, PATH lookup or caller path.
  if(restricted&&evidence.restrictedLauncherBuild!=='built')return{outcome:'restricted-launcher-unavailable'};
  const executable=restricted?launcher:helper;
  const expectedHash=restricted?evidence.restrictedLauncherSha256:evidence.helperSha256;
  const info=await lstat(executable,{bigint:true});
  if(!info.isFile()||info.isSymbolicLink()||info.size<1n||info.size>8n*1024n*1024n||hash(await readFile(executable))!==expectedHash) return {outcome:'binary-mismatch'};
  return await new Promise(resolve=>{
    let child,done=false,timer,cancelTimer,bytes=0,stderrBytes=0,cancelRequested=false,cancelAccepted=false;
    const chunks=[];
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(cancelTimer);if(child?.exitCode===null&&child?.signalCode===null){try{child.kill();}catch{}}resolve({...result,stdoutBytes:bytes,stderrBytes});};
    try {child=spawn(executable,[],{shell:false,windowsHide:true,cwd:build,env:curatedEnv(),stdio:['pipe','pipe','pipe']});}
    catch {finish({outcome:'spawn-failed'});return;}
    timer=setTimeout(()=>finish({outcome:'host-timeout'}),timeoutMs);
    child.once('spawn',()=>{
      if(cancelAfterMs!==undefined)cancelTimer=setTimeout(()=>{cancelRequested=true;try{cancelAccepted=child.kill();}catch{}},cancelAfterMs);
    });
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>(restricted?100:68))finish({outcome:'output-limit'});else chunks.push(Buffer.from(b));});
    child.stderr.on('data',b=>{stderrBytes+=b.length;finish({outcome:'unexpected-stderr'});});
    child.once('error',()=>finish({outcome:'spawn-failed'}));
    child.stdout.on('error',()=>finish({outcome:'helper-failed'}));child.stderr.on('error',()=>finish({outcome:'helper-failed'}));
    // An intentional watchdog/cancel or malformed-length early exit can close stdin.
    child.stdin.on('error',()=>{});
    child.once('close',code=>{
      if(cancelRequested){finish({outcome:cancelAccepted&&bytes===0&&stderrBytes===0?'cancelled-and-exited':'cancel-unproven'});return;}
      if(code===124){finish({outcome:bytes===0&&stderrBytes===0?'native-watchdog':'invalid-timeout-output'});return;}
      if(restricted&&code===125&&bytes===32){
        try{const blocked=decodeRestricted(Buffer.concat(chunks,bytes),request);finish(blocked.outcome==='restricted-launcher-blocked'?blocked:{outcome:'invalid-output'});}catch{finish({outcome:'invalid-output'});}return;
      }
      if(code!==0){finish({outcome:'helper-failed'});return;}
      try {finish((restricted?decodeRestricted:decodeResponse)(Buffer.concat(chunks,bytes),request));}catch{finish({outcome:'invalid-output'});}
    });
    if(keepInputOpen){if(frame.length)child.stdin.write(frame);}else child.stdin.end(frame);
  });
}
async function inspect(target,mode='locality',directory=true,allowMissingLeaf=false,restricted=false) {
  const request={path:target,mode,directory,allowMissingLeaf};
  try{return await checkedLaunch(encodeRequest(request),{request,restricted,timeoutMs:restricted?8000:6000});}catch{return{outcome:'runner-unavailable'};}
}
function malformed(body){const b=Buffer.alloc(4+body.length);b.writeUInt32LE(body.length);body.copy(b,4);return b;}
try {
  if(process.platform!=='win32'){output('NOT_RUN',{blocker:'windows-required'});process.exitCode=2;}
  else {
    const expectedSource=process.argv[2];
    if(process.arch!=='x64'||process.argv.length!==3||!/^[a-f0-9]{64}$/.test(expectedSource??''))throw Error('reviewed-source-pin-required');
    if(canonicalize(root)===null||canonicalize(process.env.SystemRoot??'')!=='C:\\Windows')throw Error('unsupported-runner-root');
    // This scope is the trusted disposable checkout's known build directory, not
    // an arbitrary user's storage. Verify ordinary directory ancestors before
    // creating only new synthetic empty fixtures; no permissions are changed.
    let cursor=path.parse(build).root;
    for(const part of build.slice(cursor.length).split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,part);const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw Error('nonordinary-research-tree');
    }
    if((await realpath(build)).toLowerCase()!==build.toLowerCase())throw Error('nonordinary-research-tree');
    const sourceHashes={};for(const name of sourceNames)sourceHashes[name]=hash(await readFile(path.join(root,name)));
    const sourceTreeSha256=hash(Buffer.from(sourceNames.map(p=>`${p}\0${sourceHashes[p]}\n`).join('')));
    if(sourceTreeSha256!==expectedSource)throw Error('source-pin-mismatch');
    const provenanceBytes=await readFile(path.join(build,'build-provenance.json'));if(provenanceBytes.length>65536)throw Error('invalid-provenance');
    const provenance=JSON.parse(provenanceBytes.toString('utf8').replace(/^\uFEFF/,''));
    if(provenance.status!=='built-not-native-accepted'||provenance.targetArchitecture!=='x64'||provenance.sourceTreeSha256!==sourceTreeSha256||!/^[a-f0-9]{64}$/.test(provenance.helperSha256??''))throw Error('build-provenance-mismatch');
    if(!['built','compile-failed'].includes(provenance.restrictedLauncherBuild))throw Error('launcher-provenance-mismatch');
    if(provenance.restrictedLauncherBuild==='built'){
      if(!/^[a-f0-9]{64}$/.test(provenance.restrictedLauncherSha256??''))throw Error('launcher-provenance-mismatch');
      const launcherBinary=await readFile(launcher);if(launcherBinary.length>8*1024*1024||hash(launcherBinary)!==provenance.restrictedLauncherSha256)throw Error('launcher-binary-mismatch');
    }
    const binary=await readFile(helper);if(binary.length>8*1024*1024||hash(binary)!==provenance.helperSha256)throw Error('binary-mismatch');
    evidence={sourceTreeSha256,helperSha256:provenance.helperSha256,restrictedLauncherBuild:provenance.restrictedLauncherBuild,restrictedLauncherSha256:provenance.restrictedLauncherSha256,compilerSha256:provenance.compilerSha256,compilerVersion:provenance.compilerVersion,sdkVersion:provenance.sdkVersion,buildProvenanceSha256:hash(provenanceBytes),node:process.version,nodeSha256:hash(await readFile(process.execPath)),libuv:process.versions.uv,architecture:process.arch,windowsRelease:os.release(),administratorRole:process.env.AGENTVAC_SMOKE_ADMIN_ROLE==='1'?'observed-true':process.env.AGENTVAC_SMOKE_ADMIN_ROLE==='0'?'observed-false':'not-observed',helperBinding:'source-built-research-only'};

    // Malformed cases are all rejected before token or filesystem access.
    const valid=encodeRequest({path:'C:\\',mode:'locality',directory:true});
    const bodies=[['short-body',Buffer.alloc(4)],['bad-magic',Buffer.from([193,214,205,177,0,1,0,0,67,58,92])],['invalid-utf8',Buffer.from([65,86,77,49,0,1,0,0,67,58,92,0xc0,0xaf])],['reserved-field',Buffer.from([65,86,77,49,0,1,1,0,67,58,92])],['unknown-mode',Buffer.from([65,86,77,49,2,1,0,0,67,58,92])],['missing-in-acl',Buffer.from([65,86,77,49,1,3,0,0,67,58,92])]];
    for(const[id,body]of bodies)mark(`protocol-${id}`,await checkedLaunch(malformed(body)),'invalid-request');
    const tooLong=Buffer.alloc(4);tooLong.writeUInt32LE(16393);mark('protocol-oversize',await checkedLaunch(tooLong),'invalid-request');
    mark('protocol-trailing-byte',await checkedLaunch(Buffer.concat([valid,Buffer.from([0])])),'invalid-request');
    mark('protocol-truncated-header',await checkedLaunch(Buffer.from([1,2])),'invalid-request');
    mark('protocol-truncated-body',await checkedLaunch(valid.subarray(0,-1)),'invalid-request');
    mark('protocol-native-watchdog',await checkedLaunch(Buffer.from([1]),{keepInputOpen:true}),'native-watchdog');
    mark('protocol-cancel-waits-for-exit',await checkedLaunch(Buffer.alloc(0),{keepInputOpen:true,cancelAfterMs:100}),'cancelled-and-exited');

    // Generate only ordinary inherited-permission directories and an empty file.
    // No ACL writes, owner changes, reparse points, mappings or provider content.
    fixtureRoot=await mkdtemp(path.join(build,'metadata-smoke-'));
    const child=path.join(fixtureRoot,'ordinary');await mkdir(child);
    emptyPath=path.join(child,'empty.bin');const file=await open(emptyPath,'wx+');
    try {
      cases.push({id:'fixed-volume-root',status:'UNAVAILABLE',actual:'standalone-root-target-outside-generated-fixture-scope'});
      mark('ordinary-directory-locality',await inspect(child),'verified-local');
      const missing=await inspect(path.join(child,'missing-final'),'locality',true,true);
      mark('missing-final-leaf',missing.outcome==='verified-local'&&missing.exists!==false?{outcome:'fixture-not-missing'}:missing,'verified-local');
      mark('missing-intermediate',await inspect(path.join(child,'missing-parent','leaf'),'locality',true,true),'locality-rejected');
      observation('generated-directory-acl',await inspect(child,'acl'));
      // Generated-fixture lane does not inspect runner profile/public ACLs.
      cases.push({id:'profile-root-candidate',status:'UNAVAILABLE',actual:'outside-generated-fixture-scope'});
      cases.push({id:'public-root-candidate',status:'UNAVAILABLE',actual:'outside-generated-fixture-scope'});
      const before=await file.stat({bigint:true});const native=await inspect(emptyPath,'acl',false);const after=await file.stat({bigint:true});
      if(native.outcome==='verified-private'){
        const i=native.identity;const agrees=before.isFile()&&before.size===0n&&before.nlink===1n&&after.size===0n&&after.nlink===1n&&before.dev===after.dev&&before.ino===after.ino&&i?.size==='0'&&i.links===1&&BigInt('0x'+i.volume32)===before.dev&&BigInt('0x'+i.fileIndex64)===before.ino;
        cases.push({id:'node-held-empty-file-identity',status:agrees?'PASS':'FAIL',actual:agrees?'same-observed-empty-object':'identity-unproven'});
      }else cases.push({id:'node-held-empty-file-identity',status:smokeIdentityFailureStatus(native.outcome),actual:native.outcome});
      // Separate fixture-only token experiment. Never feed profile/public roots
      // to this launcher and never reinterpret it as ordinary-user acceptance.
      mark('restricted-generated-directory-locality',await inspect(child,'locality',true,false,true),'verified-local');
      const missingRestricted=await inspect(path.join(child,'missing-restricted'),'locality',true,true,true);
      mark('restricted-missing-final-leaf',missingRestricted.outcome==='verified-local'&&missingRestricted.exists!==false?{outcome:'fixture-not-missing'}:missingRestricted,'verified-local');
      observation('restricted-generated-directory-acl',await inspect(child,'acl',true,false,true));
      const reduced=await inspect(emptyPath,'acl',false,false,true);const reducedAfter=await file.stat({bigint:true});
      if(reduced.outcome==='verified-private'){
        const i=reduced.identity;const agrees=reducedAfter.isFile()&&reducedAfter.size===0n&&reducedAfter.nlink===1n&&reducedAfter.dev===before.dev&&reducedAfter.ino===before.ino&&i?.size==='0'&&i.links===1&&BigInt('0x'+i.volume32)===before.dev&&BigInt('0x'+i.fileIndex64)===before.ino;
        cases.push({id:'restricted-node-held-empty-file-identity',status:agrees?'PASS':'FAIL',actual:agrees?'same-observed-empty-object':'identity-unproven',token:reduced.token});
      }else cases.push({id:'restricted-node-held-empty-file-identity',status:smokeIdentityFailureStatus(reduced.outcome),actual:reduced.outcome,...(reduced.reason?{reason:reduced.reason}:{}),...(reduced.token?{token:reduced.token}:{})});
    }finally{await file.close();}
    // Only these known newly generated empty objects are removed, non-recursively.
    await unlink(emptyPath);emptyPath=undefined;await rmdir(child);await rmdir(fixtureRoot);fixtureRoot=undefined;
    const failed=cases.some(c=>c.status==='FAIL'),hasBlocked=cases.some(c=>['BLOCKED','UNAVAILABLE'].includes(c.status));
    output(failed?'SMOKE_FAIL':hasBlocked?'PARTIAL_BLOCKED':'PARTIAL_SMOKE_COMPLETE');
    process.exitCode=failed?1:hasBlocked?2:0;
  }
}catch{output('BLOCKED',{blocker:'research-build-or-fixture-unavailable',generatedFixtureMayRemain:!!fixtureRoot});process.exitCode=2;}
// No recursive cleanup or retry against unknown paths after an exception.
