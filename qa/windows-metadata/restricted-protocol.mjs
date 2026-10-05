import {decodeResponse} from './protocol.mjs';
const reasons=Object.freeze(['none','request','binding','fixture','token','desktop','launch','job','child-token','deadline-cancel','pipe','helper-response']);
const invalid=()=>{throw new Error('invalid-restricted-protocol');};
export function decodeRestricted(frame,request){
  if(!Buffer.isBuffer(frame)||![32,100].includes(frame.length)||!frame.subarray(0,4).equals(Buffer.from([65,86,82,49])))invalid();
  const status=frame[4],reason=frame[5],candidate=frame.readUInt32LE(8),child=frame.readUInt32LE(12),flags=frame.readUInt32LE(16),length=frame.readUInt32LE(24);
  if(status>1||reason>=reasons.length||flags>63||[6,7,20,21,22,23,28,29,30,31].some(i=>frame[i]))invalid();
  const token=Object.freeze({kind:'synthetic-restricted-token',candidateIntegrityRid:candidate,childIntegrityRid:child,verifiedFlags:flags,ordinaryInteractiveAcceptance:false});
  if(status===1){if(reason===0||length!==0||frame.length!==32)invalid();return Object.freeze({outcome:'restricted-launcher-blocked',reason:reasons[reason],token});}
  if(reason!==0||length!==68||frame.length!==100||flags!==63||candidate===0||candidate>0x2000||child===0||child>0x2000||child!==candidate)invalid();
  return Object.freeze({...decodeResponse(frame.subarray(32),request),token});
}
