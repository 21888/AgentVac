import {readFile,lstat,realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {exchangeChild} from '../research-transport.mjs';
import {encodeInheritedRequest,decodeInheritedResponse,encodeFixtureRequest,decodeFixtureResponse} from '../inherited-protocol.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),build=path.join(root,'build','windows-x64');
const files={helper:path.join(build,'agentvac-metadata-research.exe'),fixture:path.join(build,'agentvac-initial-fixtures-research.exe')};
const inputs=['.gitattributes','include/core.hpp','include/inherited-context.hpp','include/inherited-policy.hpp','include/inherited-request.hpp','src/native-helper.cpp','src/fixture-constructor.cpp','src/helper.manifest','protocol.mjs','inherited-protocol.mjs','research-transport.mjs','tests/core.test.cpp','tests/inherited-policy.test.cpp','scripts/build-inherited-windows.ps1','scripts/native-inherited.mjs','scripts/source-manifest.mjs'].sort();
const hash=b=>createHash('sha256').update(b).digest('hex'),cases=[];let evidence={},knownRoot,halted=false;
const unavailable=new Set(['metadata-unavailable','identity-unavailable','context-rejected','caller-rejected','fixture-blocked','fixture-build-unavailable','spawn-failed']);
const emit=(status,extra={})=>process.stdout.write(JSON.stringify({schema:1,profile:'same-caller-inherited-context-v1',status,nativeWindows:process.platform==='win32'?'PARTIAL_ONLY':'NOT_RUN',productionAccepted:false,privateCopyActivated:false,evidence,cases,unavailableNativeCases:['preexisting-enabled-backup-token','preexisting-enabled-restore-token','different-user-peer','thread-impersonation','system-service-identity','security-races','null-write-before-eof','pipe-creator-exit-duplicated-endpoint','syscall-traces','write-containment-lease'],...extra})+'\n');
const mark=(id,result,expected)=>{cases.push({id,status:result.outcome===expected?'PASS':unavailable.has(result.outcome)?'BLOCKED':'FAIL',expected,actual:result.outcome});if(halted)throw Error('teardown-unconfirmed');};
const env={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',SystemDrive:'C:',USERPROFILE:'',APPDATA:'',LOCALAPPDATA:'',TEMP:'',TMP:'',HOMEDRIVE:'',HOMEPATH:'',PATH:''};
async function run(kind,frame,{request,endImmediately=false,keepInputOpen=false,cancel=false}={}){
  if(halted)throw Error('teardown-unconfirmed');
  if(kind==='fixture'&&evidence.fixtureBuild!=='built')return{outcome:'fixture-build-unavailable'};
  const executable=files[kind],expected=kind==='helper'?evidence.helperSha256:evidence.fixtureSha256;
  const stat=await lstat(executable,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1n||stat.size>8n*1024n*1024n||hash(await readFile(executable))!==expected)return{outcome:'binary-mismatch'};
  const result=await exchangeChild(()=>spawn(executable,[],{shell:false,windowsHide:true,cwd:build,env,stdio:['pipe','pipe','pipe']}),frame,{
    decode:bytes=>kind==='helper'?decodeInheritedResponse(bytes,request):decodeFixtureResponse(bytes),
    bodyBytes:kind==='helper'?68:44,successOutcomes:['verified-local','verified-private','fixtures-created'],
    allowBlocked125:kind==='fixture',endImmediately,keepInputOpen,cancel
  });
  if(result.teardownConfirmed===false)halted=true;
  return result;
}
async function inspect(scope,target,mode='locality',directory=true,allowMissingLeaf=false,pid=process.pid){const request={scope,path:target,mode,directory,allowMissingLeaf};const result=await run('helper',encodeInheritedRequest(request,pid),{request});if(halted)throw Error('teardown-unconfirmed');return result;}
try{
  if(process.platform!=='win32'){emit('NOT_RUN',{blocker:'windows-required'});process.exitCode=2;}
  else{
    const pin=process.argv[2],expectedSdk=process.argv[3];if(process.arch!=='x64'||process.argv.length!==4||!/^\d+\.\d+\.\d+\.\d+$/.test(expectedSdk??'')||!/^[a-f0-9]{64}$/.test(pin??'')||process.env.SystemRoot?.toLowerCase()!=='c:\\windows')throw Error('unsupported-input');
    let cursor=path.parse(build).root;for(const part of build.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw Error('nonordinary-tree');}
    if((await realpath(build)).toLowerCase()!==build.toLowerCase())throw Error('nonordinary-tree');
    const digests={};for(const p of inputs)digests[p]=hash(await readFile(path.join(root,p)));const sourceTreeSha256=hash(Buffer.from(inputs.map(p=>`${p}\0${digests[p]}\n`).join('')));if(sourceTreeSha256!==pin)throw Error('source-pin-mismatch');
    const bytes=await readFile(path.join(build,'inherited-build-provenance.json'));if(bytes.length>65536)throw Error('provenance-limit');const p=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(p.profile!=='same-caller-inherited-context-v1'||p.sourceTreeSha256!==pin||p.status!=='built-not-native-accepted'||p.targetArchitecture!=='x64'||p.sdkVersion!==expectedSdk||p.sourcePrePostMatched!==true||p.crt!=='static-MT'||!/^[a-f0-9]{64}$/.test(p.helperSha256??'')||!['built','compile-failed'].includes(p.fixtureBuild)||p.fixtureBuild==='built'&&!/^[a-f0-9]{64}$/.test(p.fixtureSha256??''))throw Error('invalid-provenance');
    evidence={sourceTreeSha256,helperSha256:p.helperSha256,fixtureBuild:p.fixtureBuild,fixtureSha256:p.fixtureSha256,compilerSha256:p.compilerSha256,compilerVersion:p.compilerVersion,sdkVersion:p.sdkVersion,provenanceSha256:hash(bytes),node:process.version,libuv:process.versions.uv,nodeSha256:hash(await readFile(process.execPath)),windowsRelease:os.release(),architecture:process.arch};
    // Invalid frames reject before caller binding or any target filesystem access.
    const dummy=path.join(build,'inherited-fixture-'+'0'.repeat(32));const request={scope:dummy,path:dummy,mode:'locality',directory:true,allowMissingLeaf:false};const valid=encodeInheritedRequest(request);
    const wrongMagic=Buffer.from(valid);wrongMagic[7]=49;mark('reject-old-protocol',await run('helper',wrongMagic,{request,endImmediately:true}),'invalid-request');
    const reserved=Buffer.from(valid);reserved[10]=1;mark('reject-reserved-field',await run('helper',reserved,{request,endImmediately:true}),'invalid-request');
    const badUtf8=Buffer.from(valid);badUtf8[badUtf8.length-1]=0xff;mark('reject-invalid-utf8',await run('helper',badUtf8,{request,endImmediately:true}),'invalid-request');
    const oversize=Buffer.alloc(4);oversize.writeUInt32LE(32785);mark('reject-oversize-frame',await run('helper',oversize,{request,endImmediately:true}),'invalid-request');
    mark('reject-truncated-frame',await run('helper',valid.subarray(0,-1),{request,endImmediately:true}),'invalid-request');
    mark('native-watchdog',await run('helper',Buffer.from([1]),{request,keepInputOpen:true}),'native-watchdog');
    mark('cancel-waits-for-exit',await run('helper',Buffer.alloc(0),{request,keepInputOpen:true,cancel:true}),'cancelled-and-exited');
    const created=await run('fixture',encodeFixtureRequest());
    if(created.outcome!=='fixtures-created'){
      cases.push({id:'initial-empty-private-broad-fixtures',status:unavailable.has(created.outcome)?'BLOCKED':'FAIL',actual:created.outcome,...(created.reasonCode?{reasonCode:created.reasonCode}:{})});
      emit(cases.some(c=>c.status==='FAIL')?'PROBE_FAIL':'PARTIAL_BLOCKED',{generatedEmptyFixturesMayRemain:true});process.exitCode=cases.some(c=>c.status==='FAIL')?1:2;
    }else{
      evidence.fixtureConstructorInheritedElevated=created.inheritedElevated;knownRoot=path.join(build,'inherited-fixture-'+created.suffix);
      const privateDir=path.join(knownRoot,'private'),broadDir=path.join(knownRoot,'broad'),privateFile=path.join(privateDir,'empty.bin'),broadFile=path.join(broadDir,'empty.bin');
      mark('private-initial-directory-acl',await inspect(knownRoot,privateDir,'acl'),'verified-private');
      mark('broad-initial-directory-acl',await inspect(knownRoot,broadDir,'acl'),'acl-rejected');
      mark('private-empty-file-acl',await inspect(knownRoot,privateFile,'acl',false),'verified-private');
      mark('broad-empty-file-acl',await inspect(knownRoot,broadFile,'acl',false),'acl-rejected');
      mark('private-directory-locality',await inspect(knownRoot,privateDir),'verified-local');
      const missing=await inspect(knownRoot,path.join(privateDir,'missing-final'),'locality',true,true);mark('missing-final-leaf',missing.outcome==='verified-local'&&missing.exists!==false?{outcome:'fixture-not-missing'}:missing,'verified-local');
      mark('missing-intermediate',await inspect(knownRoot,path.join(privateDir,'absent','leaf'),'locality',true,true),'locality-rejected');
      mark('wrong-caller-pid',await inspect(knownRoot,privateDir,'locality',true,false,process.pid===1?2:1),'caller-rejected');
      mark('outside-scope-rejected-before-filesystem',await inspect(knownRoot,'C:\\Windows'),'scope-rejected');
      mark('scope-prefix-lookalike',await inspect(knownRoot,knownRoot+'x\\private'),'scope-rejected');
      const descriptor=await open(privateFile,'r+');try{const before=await descriptor.stat({bigint:true});const result=await inspect(knownRoot,privateFile,'acl',false);const after=await descriptor.stat({bigint:true});if(result.outcome==='verified-private'){const i=result.identity;const same=before.isFile()&&before.size===0n&&before.nlink===1n&&after.size===0n&&after.nlink===1n&&before.dev===after.dev&&before.ino===after.ino&&i?.size==='0'&&i.links===1&&BigInt('0x'+i.volume32)===before.dev&&BigInt('0x'+i.fileIndex64)===before.ino;cases.push({id:'held-empty-node-file-identity',status:same?'PASS':'FAIL',actual:same?'same-observed-empty-object':'identity-unproven'});}else cases.push({id:'held-empty-node-file-identity',status:unavailable.has(result.outcome)?'BLOCKED':'FAIL',actual:result.outcome});}finally{await descriptor.close();}
      // Creation-only lane: no path-based cleanup after guards have been released.
      // Leave generated objects for the authorized disposable runner's disposal.
      const fail=cases.some(c=>c.status==='FAIL'),blocked=cases.some(c=>c.status==='BLOCKED');emit(fail?'PROBE_FAIL':blocked?'PARTIAL_BLOCKED':'PARTIAL_INHERITED_FIXTURE_PASS',{generatedFixturesLeftForRunnerDisposal:true});process.exitCode=fail?1:blocked?2:0;
    }
  }
}catch{emit(halted?'PROBE_FAIL':'BLOCKED',{blocker:halted?'child-teardown-unconfirmed':'research-input-or-fixture-unavailable',generatedEmptyFixturesMayRemain:true});process.exitCode=halted?1:2;}
