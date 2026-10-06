import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {cursorSnapshotAclIsPrivate, canonicalizeCursorSnapshotWindowsPath} from '../../AgentVac-conversation-native-corrected/electron/conversations/cursor-windows-acl.ts';
import {canonicalize,encodeRequest,decodeResponse,codes} from '../protocol.mjs';
import {validateBinding,inspectReviewed} from '../transport.mjs';
const policySource=fileURLToPath(new URL('../../AgentVac-conversation-native-corrected/electron/conversations/cursor-windows-acl.ts',import.meta.url));
const probe=fileURLToPath(new URL('../build/core-probe',import.meta.url));
const sids=['S-1-5-21-100-200-300-1001','S-1-5-18','S-1-5-32-544','S-1-1-0','bad'];
const ace=(p=0,rights=3,kind=0,inherit=3,propagate=0,inherited=false)=>({sid:sids[p],rights,type:['allow','deny','unknown'][kind],inheritance:inherit,propagation:propagate,inherited});
function check(cases) {
  const lines=cases.map(({owner,canonical,requireInheritance,entries})=>`P ${owner} ${Number(canonical)} ${Number(requireInheritance)} ${entries.length} `+entries.map(a=>`${sids.indexOf(a.sid)} ${a.rights} ${['allow','deny','unknown'].indexOf(a.type)} ${Number(a.inherited)} ${a.inheritance} ${a.propagation}`).join(' '));
  const run=spawnSync(probe,[],{input:lines.join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(run.status,0); assert.equal(run.stderr,''); const output=run.stdout.trim().split('\n'); assert.equal(output.length,cases.length);
  cases.forEach((c,i)=>assert.equal(output[i]==='1',cursorSnapshotAclIsPrivate({currentUserSid:sids[0],ownerSid:sids[c.owner],canonical:c.canonical,entries:c.entries},c.requireInheritance),`policy fixture ${i}`));
}
test('frozen policy source hash is unchanged',()=>assert.equal(createHash('sha256').update(readFileSync(policySource)).digest('hex'),'497f00ba1caedfccb02e0ac69a1812cfaf6b37b301334c177cffb71f4f6a8dfd'));
test('literal policy agrees with current TypeScript on 26040 synthetic observations',()=>{
  const cases=[];
  for(let p=0;p<5;p++)for(let kind=0;kind<3;kind++)for(const rights of [-2147483648,-1,0,1,2,3,7,0x1fffff,0x200000,0x10000000,0x80000000,0xffffffff])for(let inheritance=-1;inheritance<5;inheritance++)for(let propagation=-1;propagation<5;propagation++)for(const inherited of [false,true])for(const requireInheritance of [false,true]) {
    cases.push({owner:0,canonical:true,requireInheritance,entries:[ace(),ace(p,rights,kind,inheritance,propagation,inherited)]});
  }
  for(let owner=0;owner<5;owner++)for(const canonical of [false,true])for(const requireInheritance of [false,true])for(const entries of [[],[ace()],[ace(0,1),ace(0,2)],[ace(0,3,0,0)],[ace(3,1,1),ace()],Array(129).fill(ace())])cases.push({owner,canonical,requireInheritance,entries});
  check(cases); console.log(`policyDifferentialCases=${cases.length}; nativeWindows=NOT_RUN`);
});
test('native request path decisions agree with current canonicalizer within bounded domain',()=>{
  const paths=['C:\\','c:/valid/child/','\\\\?\\C:\\valid','C:\\\\','C:\\a\\\\b','C:\\a\\','C:relative','//?/C:/a','\\\\server\\share','\\\\?\\UNC\\host\\share','C:\\a:stream','C:\\a.','C:\\a ','C:\\..','C:\\.','C:\\NUL.txt','C:\\CONIN$','C:\\com¹.txt','C:\\LPT²','C:\\日本語\\🟢','C:\\a\u0000','C:\\x\u007f'];
  for(let i=0;i<500;i++)paths.push(`C:\\test${i}\\${String.fromCharCode(i)}file`);
  const lines=paths.map(p=>{const body=Buffer.concat([Buffer.from([65,86,77,49,0,1,0,0]),Buffer.from(p)]);return `R ${body.toString('hex')}`;});
  const run=spawnSync(probe,[],{input:lines.join('\n')+'\n',encoding:'utf8'});assert.equal(run.status,0); const output=run.stdout.trim().split('\n');
  paths.forEach((p,i)=>{const expected=canonicalizeCursorSnapshotWindowsPath(p);assert.equal(canonicalize(p),expected,`JS path fixture ${i}`);assert.equal(output[i]==='1',!!expected,`C++ path fixture ${i}`);});
});
test('malformed UTF-8, flags, request lengths and UTF-16 are rejected',()=>{
  const invalid=[[0xc0,0xaf],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0x80],[0xe2,0x82]];
  const bodies=invalid.map(x=>Buffer.from([65,86,77,49,0,1,0,0,67,58,92,...x]));
  bodies.push(Buffer.from([65,86,77,49,1,3,0,0,67,58,92]),Buffer.from([65,86,77,49,0,2,0,0,67,58,92]),Buffer.from([65,86,77,49,0,1,1,0,67,58,92]),Buffer.from([65,86,77,49,0,1,0,0,67,58,92,...Buffer.alloc(4094,97)]));
  const run=spawnSync(probe,[],{input:bodies.map(b=>`R ${b.toString('hex')}`).join('\n')+'\n',encoding:'utf8'});assert.equal(run.status,0);assert.deepEqual(run.stdout.trim().split('\n'),bodies.map(()=> '0'));
  assert.equal(canonicalize('C:\\\ud800'),null);assert.equal(canonicalize('C:\\'+('a\\'.repeat(129))),null);
  assert.throws(()=>encodeRequest({path:'C:\\x',mode:'acl',directory:true,allowMissingLeaf:true}));
});
function frame(code=0,flags=5){const b=Buffer.alloc(68);b.writeUInt32LE(64);b.write('AVM1',4);b[8]=code;b[9]=flags;if(flags){b.writeUInt32LE(1,36);b.writeUInt32LE(flags===7?16:32,40);}return b;}
test('strict response parser enforces size, reserved bits, mode, missing and identity shape',()=>{
  const request={mode:'locality',directory:false};assert.equal(decodeResponse(frame(),request).outcome,'verified-local');
  for(let c=2;c<codes.length;c++)assert.equal(decodeResponse(frame(c,0),request).outcome,codes[c]);
  for(const b of [Buffer.alloc(0),frame().subarray(1),Buffer.concat([frame(),Buffer.from([0])]),frame(8),frame(0,1),frame(1),frame(0,0)])assert.throws(()=>decodeResponse(b,request));
  const highBitMagic=frame(); for(let i=4;i<8;i++)highBitMagic[i]|=0x80;assert.throws(()=>decodeResponse(highBitMagic,request));
  const b=frame();b[10]=1;assert.throws(()=>decodeResponse(b,request));
  const leak=frame(4,0);leak[12]=1;assert.throws(()=>decodeResponse(leak,request));
  assert.deepEqual(decodeResponse(frame(0,0),{...request,allowMissingLeaf:true}),{outcome:'verified-local',exists:false});
  assert.throws(()=>decodeResponse(frame(),{...request,directory:true}));
});
test('transport has no implicit native activation and requires exact reviewed binding',async()=>{
  assert.equal(validateBinding({}),false);
  const binding={schema:1,systemRoot:'C:\\Windows',helperPath:'C:\\reviewed\\agentvac-metadata-research.exe',helperSha256:'a'.repeat(64),sourceTreeSha256:'b'.repeat(64),reviewId:'review-1',bootstrap:'trusted-local-nonreparse-installation'};
  assert.equal(validateBinding(binding),true);assert.equal(validateBinding({...binding,helperPath:'agentvac-metadata-research.exe'}),false);assert.equal(validateBinding({...binding,helperPath:'C:\\reviewed\\powershell.exe'}),false);
  const controller=new AbortController();controller.abort();assert.equal((await inspectReviewed(binding,{},controller.signal)).outcome,'cancelled');
  if(process.platform!=='win32')assert.equal((await inspectReviewed(binding,{})).outcome,'not-windows');
});
