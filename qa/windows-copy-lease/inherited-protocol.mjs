import {canonicalize} from './protocol.mjs';
const outcomes=Object.freeze(['verified-local','verified-private','invalid-request','locality-rejected','acl-rejected','metadata-unavailable','timeout','identity-unavailable','context-rejected','caller-rejected','scope-rejected']);
const invalid=()=>{throw new Error('invalid-inherited-protocol');};
export function encodeInheritedRequest(request,callerPid=process.pid){
  const scope=canonicalize(request.scope),target=canonicalize(request.path);
  if(!scope||!target||!Number.isInteger(callerPid)||callerPid<1||callerPid>0xffffffff||!['locality','acl'].includes(request.mode)||typeof request.directory!=='boolean'||typeof request.allowMissingLeaf!=='boolean'||request.allowMissingLeaf&&(request.mode!=='locality'||!request.directory))invalid();
  const a=Buffer.from(scope),b=Buffer.from(target);if(a.length>16384||b.length>16384)invalid();
  const frame=Buffer.alloc(20+a.length+b.length);frame.writeUInt32LE(frame.length-4,0);frame.write('AVM2',4);frame[8]=Number(request.mode==='acl');frame[9]=Number(request.directory)|(Number(request.allowMissingLeaf)<<1);frame.writeUInt32LE(callerPid,12);frame.writeUInt32LE(a.length,16);a.copy(frame,20);b.copy(frame,20+a.length);return frame;
}
export function decodeInheritedResponse(frame,request){
  if(!Buffer.isBuffer(frame)||frame.length!==68||frame.readUInt32LE(0)!==64||!frame.subarray(4,8).equals(Buffer.from([65,86,77,50])))invalid();
  const body=frame.subarray(4),code=body[4],flags=body[5];if(code>=outcomes.length||![0,5,7].includes(flags)||body[6]||body[7])invalid();
  if(code>1){if(flags||body.subarray(8).some(Boolean))invalid();return Object.freeze({outcome:outcomes[code]});}
  if((code===1)!==(request.mode==='acl'))invalid();
  if(!flags){if(!request.allowMissingLeaf||code!==0||body.subarray(8).some(Boolean))invalid();return Object.freeze({outcome:outcomes[code],exists:false});}
  const directory=(flags&2)!==0,attrs=body.readUInt32LE(36),links=body.readUInt32LE(32);
  if(request.directory&&!directory||!!(attrs&16)!==directory||attrs&0x400||!links||body.readBigUInt64LE(8)>0xffffffffn)invalid();
  return Object.freeze({outcome:outcomes[code],exists:true,directory,identity:Object.freeze({volume32:body.readBigUInt64LE(8).toString(16).padStart(8,'0'),fileIndex64:body.readBigUInt64LE(16).toString(16).padStart(16,'0'),size:body.readBigUInt64LE(24).toString(),links,volume64:body.readBigUInt64LE(40).toString(16).padStart(16,'0'),fileId128:body.subarray(48,64).toString('hex')})});
}
export function encodeFixtureRequest(callerPid=process.pid){if(!Number.isInteger(callerPid)||callerPid<1||callerPid>0xffffffff)invalid();const b=Buffer.alloc(12);b.writeUInt32LE(8);b.write('AVF1',4);b.writeUInt32LE(callerPid,8);return b;}
export function decodeFixtureResponse(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==44||!frame.subarray(0,4).equals(Buffer.from([65,86,67,49]))||frame[4]>1||frame[6]>1||frame[7]||frame.subarray(40).some(Boolean))invalid();
  if(frame[4]===1){if(frame[5]===0||frame[5]>10||frame.subarray(8,40).some(Boolean))invalid();return{outcome:'fixture-blocked',reasonCode:frame[5],inheritedElevated:!!frame[6]};}
  const suffix=frame.subarray(8,40).toString('utf8');if(frame[5]!==0||!/^[a-f0-9]{32}$/.test(suffix))invalid();return{outcome:'fixtures-created',suffix,inheritedElevated:!!frame[6]};
}
