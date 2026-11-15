import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { brokerModel } from '../runtime/model-transport.mjs';
import { createModelStream } from '../runtime/model-stream.mjs';
const connection={url:'https://api.vendor.com/v1/chat/completions',model:'model',key:'test-private-key'};
const raw=JSON.stringify({messages:[],tools:[],stream:true});
function upstream({chunks=[],end=80,headersAt=0,status=200,type='text/event-stream'}={}){
 return (url,options,callback)=>{
  assert.equal(options.headers.Authorization,'Bearer '+connection.key);assert.equal(options.headers['Accept-Encoding'],'identity');
  const response=new PassThrough();response.statusCode=status;response.headers={'content-type':type};response.on('error',()=>{});
  const request=new EventEmitter(),timers=[];let aborted=false;
  const abort=()=>{aborted=true;const error=Object.assign(Error('Aborted'),{code:'ABORT_ERR'});request.emit('error',error);response.destroy(error);};
  options.signal.addEventListener('abort',abort,{once:true});
  request.end=payload=>{assert.equal(JSON.parse(payload).stream,true);timers.push(setTimeout(()=>{if(!aborted)callback(response);},headersAt));for(const [at,bytes] of chunks)timers.push(setTimeout(()=>{if(!aborted)response.write(bytes);},at));timers.push(setTimeout(()=>{if(!aborted)response.end();},end));};
  request.destroy=()=>{timers.forEach(clearTimeout);options.signal.removeEventListener('abort',abort);response.destroy();};
  return request;
 };
}
const resolve=async()=>[{address:'1.1.1.1',family:4}];
test('model proxy forwards SSE before upstream EOF and tolerates a continuously active stream beyond the first-byte deadline',async()=>{
 const events=[];let closed=false;
 const request=upstream({chunks:[[5,Buffer.from('data: first response\n\n')],[45,Buffer.from('data: second response\n\n')],[85,Buffer.from('data: third response\n\n')],[125,Buffer.from('data: [DONE]\n\n')]],end:145});
 const result=await brokerModel(connection,raw,new AbortController().signal,async event=>{events.push(event);if(event.type==='chunk')assert.equal(closed,false);},{resolve,request,timeouts:{firstByteMs:60,idleMs:65,totalMs:400}});
 closed=true;assert.equal(result.streamed,true);assert.equal(result.body,undefined);assert.ok(events.some(e=>e.type==='chunk'));assert.match(Buffer.concat(events.filter(e=>e.type==='chunk').map(e=>e.data)).toString(),/first response/);
});
test('stream redaction and UTF-8 decoding survive network chunk boundaries without leaking the model key',async()=>{
 const text='data: {"text":"中文'+connection.key+'文字"}\n\ndata: [DONE]\n\n',bytes=Buffer.from(text),chunks=[];
 for(let offset=0;offset<bytes.length;offset+=7)chunks.push([5+offset,bytes.subarray(offset,offset+7)]);
 const events=[];await brokerModel(connection,raw,undefined,e=>events.push(e),{resolve,request:upstream({chunks,end:bytes.length+20}),timeouts:{firstByteMs:200,idleMs:200,totalMs:500}});
 const output=Buffer.concat(events.filter(e=>e.type==='chunk').map(e=>e.data)).toString();assert.equal(output,text.replace(connection.key,'[redacted]'));assert.doesNotMatch(output,/test-private-key/);
});
test('model transport differentiates first-byte, idle and total timeout and rejects non-SSE or non-public endpoints',async()=>{
 for(const [kind,scenario,timeouts]of[
  ['AGENT_MODEL_FIRST_BYTE_TIMEOUT',{headersAt:90,end:120},{firstByteMs:20,idleMs:40,totalMs:200}],
  ['AGENT_MODEL_IDLE_TIMEOUT',{chunks:[[3,Buffer.from('data: start\n\n')]],end:120},{firstByteMs:80,idleMs:20,totalMs:200}],
  ['AGENT_MODEL_TOTAL_TIMEOUT',{chunks:Array.from({length:15},(_,i)=>[i*10+1,Buffer.from(': keepalive\n\n')]),end:180},{firstByteMs:80,idleMs:80,totalMs:45}],
 ])await assert.rejects(brokerModel(connection,raw,undefined,()=>{},{resolve,request:upstream(scenario),timeouts}),e=>e.code===kind);
 await assert.rejects(brokerModel(connection,raw,undefined,()=>{},{resolve,request:upstream({status:401})}),e=>e.code==='AGENT_MODEL_AUTH');
 await assert.rejects(brokerModel(connection,raw,undefined,()=>{},{resolve,request:upstream({type:'application/json'})}),e=>e.code==='AGENT_MODEL_PROTOCOL');
 await assert.rejects(brokerModel(connection,raw,undefined,()=>{},{resolve:async()=>[{address:'127.0.0.1',family:4}],request:()=>{throw Error('Do not connect');}}),e=>e.code==='AGENT_MODEL_ADDRESS');
});
test('E2B model bridge delivers first bytes before completion, ignores duplicate chunks and propagates stream errors',async()=>{
 const sent=[],bridge=createModelStream({send:m=>sent.push(m),nextId:()=>1});
 const pending=bridge.fetchModel(raw);assert.equal(sent[0].operation,'model');
 bridge.handle({type:'rpc_stream_start',id:1,status:200,contentType:'text/event-stream'});
 const response=await pending,reader=response.body.getReader();
 bridge.handle({type:'rpc_stream_chunk',id:1,sequence:1,data:Buffer.from('data: early\n\n').toString('base64')});
 bridge.handle({type:'rpc_stream_chunk',id:1,sequence:1,data:Buffer.from('duplicate').toString('base64')});
 assert.equal(new TextDecoder().decode((await reader.read()).value),'data: early\n\n');
 bridge.handle({type:'rpc_result',id:1,error:'模型流连续 90 秒没有新数据',code:'AGENT_MODEL_IDLE_TIMEOUT'});
 await assert.rejects(reader.read(),/AGENT_MODEL_IDLE_TIMEOUT/);
});
test('consumer completion closes only its model request while explicit cancellation aborts streaming',async()=>{
 const sent=[],bridge=createModelStream({send:m=>sent.push(m),nextId:()=>1});const pending=bridge.fetchModel(raw);
 bridge.handle({type:'rpc_stream_start',id:1,status:200,contentType:'text/event-stream'});const response=await pending;await response.body.cancel();assert.equal(sent.at(-1).reason,'consumer_done');
 const controller=new AbortController(),pending2=bridge.fetchModel(raw,controller.signal);controller.abort();await assert.rejects(pending2,e=>e.name==='AbortError');assert.equal(sent.at(-1).reason,'aborted');
});

test('a complete SSE DONE frame is delivered immediately even when the upstream HTTP connection stays open',async()=>{
 const controller=new AbortController(),received=[];
 const result=await brokerModel(connection,raw,controller.signal,event=>{if(event.type==='chunk'){received.push(event.data);if(Buffer.concat(received).toString().includes('[DONE]'))controller.abort({code:'MODEL_CONSUMER_DONE'});}},{resolve,request:upstream({chunks:[[3,Buffer.from('data: [DONE]\n\n')]],end:300}),timeouts:{firstByteMs:100,idleMs:100,totalMs:500}});
 assert.equal(result.streamed,true);assert.match(Buffer.concat(received).toString(),/\[DONE\]/);
});
