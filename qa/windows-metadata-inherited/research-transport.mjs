// Bounded research-only pipe exchange. Executable selection stays in the caller.
// No abnormal path resolves as terminated merely because kill() was requested.
export async function exchangeChild(spawnChild,frame,{decode,bodyBytes,successOutcomes,allowBlocked125=false,endImmediately=false,keepInputOpen=false,cancel=false,timeoutMs=6500,terminationWaitMs=1000,cancelAfterMs=100}={}){
  return await new Promise(resolve=>{
    let child,done=false,timer,cancelTimer,stopTimer,ack=false,total=0,stderr=0,stopping=null,killAccepted=false;let output=Buffer.alloc(0);
    const settle=result=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(cancelTimer);clearTimeout(stopTimer);resolve(result);};
    const stop=outcome=>{
      if(done||stopping)return;stopping=outcome;
      try{killAccepted=child.kill();}catch{killAccepted=false;}
      stopTimer=setTimeout(()=>settle({outcome:'teardown-unconfirmed',teardownConfirmed:false}),terminationWaitMs);
    };
    try{child=spawnChild();}catch{settle({outcome:'spawn-failed',teardownConfirmed:true});return;}
    timer=setTimeout(()=>stop('host-timeout'),timeoutMs);
    child.once('spawn',()=>{if(cancel)cancelTimer=setTimeout(()=>stop('cancelled'),cancelAfterMs);});
    child.stdout.on('data',chunk=>{
      if(done)return;total=Math.min(bodyBytes+5,total+chunk.length);if(stopping)return;
      if(total>bodyBytes+4){stop('output-limit');return;}
      output=Buffer.concat([output,chunk]);
      if(!ack&&output.length>=4&&output.subarray(0,4).equals(Buffer.from('AVH2'))){ack=true;output=output.subarray(4);if(!keepInputOpen){try{child.stdin.end();}catch{stop('helper-failed');}}}
    });
    child.stderr.on('data',chunk=>{stderr+=chunk.length;stop('unexpected-stderr');});
    child.once('error',()=>stop('spawn-failed'));
    child.stdout.on('error',()=>stop('helper-failed'));child.stderr.on('error',()=>stop('helper-failed'));
    // Early validated rejection may close stdin while an inert request finishes.
    child.stdin.on('error',()=>{});
    child.once('close',code=>{
      if(done)return;
      if(stopping){const outcome=stopping==='cancelled'?(killAccepted&&total===0&&stderr===0?'cancelled-and-exited':'cancel-unproven'):stopping;settle({outcome,teardownConfirmed:true});return;}
      if(code===124){settle({outcome:total===0&&stderr===0?'native-watchdog':'invalid-timeout-output',teardownConfirmed:true});return;}
      try{
        const parsed=decode(output);
        if(code!==0&&!(allowBlocked125&&code===125&&parsed.outcome==='fixture-blocked')){settle({outcome:'helper-failed',teardownConfirmed:true});return;}
        if(successOutcomes.includes(parsed.outcome)&&!ack){settle({outcome:'missing-context-ack',teardownConfirmed:true});return;}
        settle({...parsed,teardownConfirmed:true});
      }catch{settle({outcome:'invalid-output',teardownConfirmed:true});}
    });
    try{if(frame.length)child.stdin.write(frame);if(endImmediately)child.stdin.end();}catch{stop('helper-failed');}
  });
}
