// Streaming RPC bridge used inside E2B. It never receives the real model credential.
export function createModelStream({send,nextId}){
  const pending=new Map(),waiters=new Set();
  const finish=(id,p)=>{pending.delete(id);p.signal?.removeEventListener('abort',p.abort);if(!pending.size){for(const resolve of waiters)resolve();waiters.clear();}};
  function fetchModel(body,signal){
    if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
    const id=nextId();
    return new Promise((resolve,reject)=>{
      const p={resolve,reject,signal,controller:null,sequence:0};
      const cancel=reason=>{
        if(p.consumerClosed)return;
        const error=new DOMException('Aborted','AbortError');
        if(reason==='consumer_done') { p.consumerClosed=true;p.signal?.removeEventListener('abort',p.abort); }
        else { if(p.controller){try{p.controller.error(error);}catch{}}else reject(error);finish(id,p); }
        send({type:'rpc_cancel',id,reason});
      };
      p.cancel=cancel;p.abort=()=>cancel('aborted');
      pending.set(id,p);signal?.addEventListener('abort',p.abort,{once:true});
      send({type:'rpc',id,operation:'model',payload:{body}});
    });
  }
  function handle(message){
    const p=pending.get(message.id);if(!p)return false;
    if(p.consumerClosed){if(message.type==='rpc_result')finish(message.id,p);return true;}
    if(message.type==='rpc_stream_start'){
      const stream=new ReadableStream({start(controller){p.controller=controller;},cancel(){p.cancel('consumer_done');}});
      p.resolve(new Response(stream,{status:message.status,headers:{'Content-Type':message.contentType}}));
    }else if(message.type==='rpc_stream_chunk'){
      if(message.sequence<=p.sequence)return true;p.sequence=message.sequence;
      p.controller?.enqueue(new Uint8Array(Buffer.from(message.data,'base64')));
    }else if(message.type==='rpc_result'){
      if(message.error){const error=Error(message.error+(message.code?' ['+message.code+']':''));if(p.controller)p.controller.error(error);else p.reject(error);}
      else if(p.controller)p.controller.close();
      else p.resolve(new Response(message.result?.body||'',{status:message.result?.status||200,headers:{'Content-Type':message.result?.contentType||'text/event-stream'}}));
      finish(message.id,p);
    }else return false;
    return true;
  }
  async function drain(){
    if(!pending.size)return;let timer,done;
    try{await Promise.race([new Promise(resolve=>{done=resolve;waiters.add(resolve);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Model stream final confirmation timed out')),30000);})]);}
    finally{clearTimeout(timer);if(done)waiters.delete(done);}
  }
  return {fetchModel,handle,drain};
}
