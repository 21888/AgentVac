import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encodeInheritedRequest,decodeInheritedResponse,encodeFixtureRequest,decodeFixtureResponse} from '../inherited-protocol.mjs';
const request={scope:'C:\\build\\windows-x64\\inherited-fixture-'+'a'.repeat(32),path:'C:\\target',mode:'acl',directory:false,allowMissingLeaf:false};
function response(code=1,flags=5){const b=Buffer.alloc(68);b.writeUInt32LE(64);b.write('AVM2',4);b[8]=code;b[9]=flags;if(flags){b.writeUInt32LE(1,36);b.writeUInt32LE(flags===7?16:32,40);}return b;}
test('inherited request frames bind caller PID and independently bounded scope/target',()=>{
  const b=encodeInheritedRequest(request,123);assert.equal(b.readUInt32LE(0),b.length-4);assert.equal(b.toString('ascii',4,8),'AVM2');assert.equal(b.readUInt32LE(12),123);assert.equal(b.readUInt32LE(16),Buffer.byteLength(request.scope));
  for(const pid of [0,-1,1.5,0x100000000])assert.throws(()=>encodeInheritedRequest(request,pid));
  assert.throws(()=>encodeInheritedRequest({...request,scope:'\\\\host\\share'},123));assert.throws(()=>encodeInheritedRequest({...request,path:'C:\\'+ 'a'.repeat(4097)},123));
});
test('inherited responses retain strict ACL/locality identity shape and new refusals',()=>{
  assert.equal(decodeInheritedResponse(response(),request).outcome,'verified-private');
  for(const [code,expected] of [[8,'context-rejected'],[9,'caller-rejected'],[10,'scope-rejected']])assert.equal(decodeInheritedResponse(response(code,0),request).outcome,expected);
  for(const bad of [Buffer.alloc(0),response().subarray(1),response(11,0),response(8,5)])assert.throws(()=>decodeInheritedResponse(bad,request));
  const old=response();old[7]=49;assert.throws(()=>decodeInheritedResponse(old,request));
  const leak=response(8,0);leak[12]=1;assert.throws(()=>decodeInheritedResponse(leak,request));
});
test('constructor protocol carries only bounded status and generated suffix',()=>{
  assert.equal(encodeFixtureRequest(123).length,12);assert.throws(()=>encodeFixtureRequest(0));
  const b=Buffer.alloc(44);b.write('AVC1');b[6]=1;b.write('a'.repeat(32),8);assert.deepEqual(decodeFixtureResponse(b),{outcome:'fixtures-created',suffix:'a'.repeat(32),inheritedElevated:true});
  b[8]=0xff;assert.throws(()=>decodeFixtureResponse(b));const denied=Buffer.alloc(44);denied.write('AVC1');denied[4]=1;denied[5]=3;assert.equal(decodeFixtureResponse(denied).outcome,'fixture-blocked');denied[5]=11;assert.throws(()=>decodeFixtureResponse(denied));
});
test('revised helper stays read-only and has no old blanket elevation refusal',async()=>{
  const source=await readFile(new URL('../src/native-helper.cpp',import.meta.url),'utf8');
  assert.doesNotMatch(source,/TokenIsElevated\s*\)/);assert.doesNotMatch(source,/SetNamedSecurityInfo|SetSecurityInfo\s*\(|AdjustTokenPrivileges|CreateDirectoryW|CREATE_NEW|SetTokenInformation|CreateProcessAsUser/);
  assert(source.includes('bindCaller(input,request.callerPid,caller)'));assert(source.includes('generatedScope(request)'));assert(source.includes('writeExact(output,"AVH2",4)'));assert(source.includes('if (!read && count == 0 && error == ERROR_BROKEN_PIPE)'));assert(source.includes('if (read && count == 0) continue;'));
});
test('constructor only initializes new descriptors and the inherited runner keeps nonlocal probes out',async()=>{
  const source=await readFile(new URL('../src/fixture-constructor.cpp',import.meta.url),'utf8');assert.doesNotMatch(source,/SetNamedSecurityInfo|SetSecurityInfo\s*\(|AdjustTokenPrivileges|SetTokenInformation|CREATE_ALWAYS|TRUNCATE_EXISTING|OPEN_ALWAYS/);assert(source.includes('CREATE_NEW'));assert(source.includes('CreateDirectoryW'));
  const runner=await readFile(new URL('../scripts/native-inherited.mjs',import.meta.url),'utf8');assert.doesNotMatch(runner,/process\.env\.(USERPROFILE|PUBLIC)\b|recursive\s*:\s*true|\.writeFile\(/);assert(runner.includes('exchangeChild('));assert.doesNotMatch(runner,/await unlink|await rmdir/);
  const transport=await readFile(new URL('../research-transport.mjs',import.meta.url),'utf8');assert(transport.includes("output.subarray(0,4).equals(Buffer.from('AVH2'))"));
});
test('new native lane truthfully refuses execution on Linux',()=>{
  if(process.platform==='win32')return;const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/native-inherited.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,2);const output=JSON.parse(r.stdout);assert.equal(output.nativeWindows,'NOT_RUN');assert.equal(output.privateCopyActivated,false);assert.deepEqual(output.cases,[]);
});
