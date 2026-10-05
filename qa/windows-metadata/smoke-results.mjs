const unavailable=new Set(['metadata-unavailable','identity-unavailable','restricted-launcher-blocked','restricted-launcher-unavailable','runner-unavailable','spawn-failed']);
export function smokeObservationStatus(outcome){
  if(['verified-private','acl-rejected'].includes(outcome))return 'OBSERVED';
  return unavailable.has(outcome)||outcome==='locality-rejected'?'BLOCKED':'FAIL';
}
export function smokeExpectationStatus(actual,expected){
  return actual===expected?'PASS':unavailable.has(actual)?'BLOCKED':'FAIL';
}
export function smokeIdentityFailureStatus(outcome){
  return unavailable.has(outcome)||['acl-rejected','locality-rejected'].includes(outcome)?'BLOCKED':'FAIL';
}
