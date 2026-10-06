import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {exchangeChild} from '../research-transport.mjs';
function fakeChild(onKill){const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.write=()=>true;c.ends=0;c.stdin.end=()=>{c.ends++;};c.kills=0;c.kill=()=>{c.kills++;return onKill?.(c)??true;};return c;}
const settings={decode:()=>({outcome:'fixture-blocked'}),bodyBytes:44,successOutcomes:['fixtures-created'],allowBlocked125:true,timeoutMs:200,terminationWaitMs:80};
test('stderr failure waits for child close rather than kill request',async()=>{
  const c=fakeChild(child=>{setTimeout(()=>child.emit('close',125),35);return true;});let settled=false;
  const pending=exchangeChild(()=>c,Buffer.alloc(0),settings).then(value=>{settled=true;return value;});c.stderr.emit('data',Buffer.from('x'));
  await new Promise(r=>setTimeout(r,8));assert.equal(settled,false);assert.equal(c.kills,1);
  assert.deepEqual(await pending,{outcome:'unexpected-stderr',teardownConfirmed:true});
});
test('missing close is reported unconfirmed and never a completed teardown',async()=>{
  const c=fakeChild();const result=await exchangeChild(()=>c,Buffer.alloc(0),{...settings,timeoutMs:5,terminationWaitMs:8});
  assert.equal(c.kills,1);assert.deepEqual(result,{outcome:'teardown-unconfirmed',teardownConfirmed:false});
});
test('stdout after cancellation is counted until close',async()=>{
  const c=fakeChild(child=>{setTimeout(()=>child.stdout.emit('data',Buffer.from('late')),2);setTimeout(()=>child.emit('close',1),7);return true;});
  const pending=exchangeChild(()=>c,Buffer.alloc(0),{...settings,cancel:true,cancelAfterMs:1});c.emit('spawn');
  assert.deepEqual(await pending,{outcome:'cancel-unproven',teardownConfirmed:true});
});
test('valid acknowledged reply is not settled until actual close',async()=>{
  const c=fakeChild();let settled=false;const pending=exchangeChild(()=>c,Buffer.from('request'),{...settings,bodyBytes:4,decode:b=>{assert.equal(b.toString(),'data');return{outcome:'fixtures-created'};}}).then(v=>{settled=true;return v;});
  c.stdout.emit('data',Buffer.from('AV'));c.stdout.emit('data',Buffer.from('H2data'));assert.equal(c.ends,1);
  await new Promise(r=>setTimeout(r,3));assert.equal(settled,false);c.emit('close',0);assert.deepEqual(await pending,{outcome:'fixtures-created',teardownConfirmed:true});
});
