import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { StringDecoder } from 'node:string_decoder';
import { publicUrl, isPublicAddress } from './public-page.mjs';
export const MODEL_TIMEOUTS=Object.freeze({ firstByteMs:120000,idleMs:90000,totalMs:300000 });
export class ModelTransportError extends Error {constructor(code,message){super(message);this.code=code;}}
export function modelHttpError(status){
  if([401,403].includes(status))return new ModelTransportError('AGENT_MODEL_AUTH','模型服务鉴权失败（HTTP '+status+'），请检查 Key 与模型权限');
  if(status===402)return new ModelTransportError('AGENT_MODEL_QUOTA','模型账户额度不足（HTTP 402），请检查余额');
  if(status===404)return new ModelTransportError('AGENT_MODEL_NOT_FOUND','模型或接口不存在（HTTP 404），请检查接口地址和模型名');
  if(status===429)return new ModelTransportError('AGENT_MODEL_RATE_LIMIT','模型服务限流（HTTP 429），请稍后重试');
  return new ModelTransportError('AGENT_MODEL_HTTP','模型服务返回 HTTP '+status+'，本次调用未完成');
}
// This is a streaming transport. Only a small redaction tail and a short batching buffer are held.
export async function brokerModel(connection,raw,signal,onStream,{resolve=lookup,request=https.request,timeouts=MODEL_TIMEOUTS}={}){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)throw new ModelTransportError('AGENT_MODEL_REQUEST','模型请求超过大小限制');
  const input=JSON.parse(raw);if(!Array.isArray(input.messages)||!Array.isArray(input.tools))throw new ModelTransportError('AGENT_MODEL_REQUEST','模型工具请求格式不正确');
  const url=publicUrl(connection.url),controller=new AbortController();let timeoutError;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const total=setTimeout(()=>{timeoutError=new ModelTransportError('AGENT_MODEL_TOTAL_TIMEOUT','单次模型调用超过 5 分钟总时限');controller.abort();},timeouts.totalMs);
  let headerTimer,firstTimer,idleTimer,flushTimer,req,response,received=false;
  const timed=(code,message)=>{timeoutError=new ModelTransportError(code,message);controller.abort();};
  let streamError,sendChain=Promise.resolve(),buffer=[],bufferBytes=0,started=false;
  const flush=()=>{
    clearTimeout(flushTimer);flushTimer=null;if(!bufferBytes)return;
    const data=Buffer.concat(buffer);buffer=[];bufferBytes=0;
    sendChain=sendChain.then(async()=>{if(streamError)return;try{await onStream?.({type:'chunk',data});}catch{streamError=new ModelTransportError('AGENT_MODEL_RELAY','模型数据转发到沙箱时连接中断');controller.abort();}});
  };
  const queue=data=>{if(!data.length)return;buffer.push(data);bufferBytes+=data.length;if(!started||bufferBytes>=8192){started=true;flush();}else if(!flushTimer)flushTimer=setTimeout(flush,100);};
  try{
    headerTimer=setTimeout(()=>timed('AGENT_MODEL_FIRST_BYTE_TIMEOUT','等待模型首包超过 120 秒，服务尚未开始响应'),timeouts.firstByteMs);
    const addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{if(controller.signal.aborted)reject(Error('Aborted'));else controller.signal.addEventListener('abort',()=>reject(Error('Aborted')),{once:true});})]);
    if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new ModelTransportError('AGENT_MODEL_ADDRESS','模型地址指向非公网服务，已拒绝连接');
    const address=addresses[0],payload=JSON.stringify({...input,model:connection.model,stream:true,max_tokens:Math.min(Number(input.max_tokens)||3600,3600)});
    response=await new Promise((done,fail)=>{
      req=request(url,{method:'POST',agent:false,signal:controller.signal,lookup(host,options,callback){options.all?callback(null,[address]):callback(null,address.address,address.family);},headers:{Authorization:'Bearer '+connection.key,'Content-Type':'application/json',Accept:'text/event-stream','Accept-Encoding':'identity','Content-Length':Buffer.byteLength(payload)}},done);
      req.on('error',fail);req.end(payload);
    });
    clearTimeout(headerTimer);const status=response.statusCode||500;
    if(status<200||status>=300){response.destroy();throw modelHttpError(status);}
    const contentType=String(response.headers['content-type']||'');
    if(!/text\/event-stream/i.test(contentType)){response.destroy();throw new ModelTransportError('AGENT_MODEL_PROTOCOL','模型服务未返回 SSE 流，请确认接口支持流式工具调用');}
    try { await onStream?.({type:'start',status,contentType}); } catch { throw new ModelTransportError('AGENT_MODEL_RELAY','模型响应头转发到沙箱失败'); }
    firstTimer=setTimeout(()=>timed('AGENT_MODEL_FIRST_BYTE_TIMEOUT','模型已连接，但超过 120 秒没有返回首段数据'),timeouts.firstByteMs);
    const decoder=new StringDecoder('utf8'),secret=connection.key||'';let tail='',size=0,body='';
    const redact=(text,last=false)=>{
      tail+=text;if(secret)tail=tail.split(secret).join('[redacted]');
      const length=last?tail.length:Math.max(0,tail.length-Math.max(0,secret.length-1));
      const part=tail.slice(0,length);tail=tail.slice(length);
      if(onStream)queue(Buffer.from(part,'utf8'));else body+=part;
    };
    for await(const chunk of response){
      received=true;clearTimeout(firstTimer);clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>timed('AGENT_MODEL_IDLE_TIMEOUT','模型流式响应已开始，但连续 90 秒没有新数据'),timeouts.idleMs);
      size+=chunk.length;if(size>2*1024*1024)throw new ModelTransportError('AGENT_MODEL_RESPONSE_LIMIT','模型流式响应超过大小限制');
      redact(decoder.write(chunk));
      if(bufferBytes>=65536)await sendChain;
    }
    clearTimeout(firstTimer);clearTimeout(idleTimer);
    redact(decoder.end(),true);flush();await sendChain;
    if(streamError)throw streamError;
    if(controller.signal.aborted)throw timeoutError||Error('Aborted');
    return {status,contentType,...(onStream?{streamed:true}:{body})};
  }catch(error){
    if(signal?.aborted && signal.reason?.code==='MODEL_CONSUMER_DONE') return {status:200,contentType:'text/event-stream',streamed:true};
    if(streamError)throw streamError;if(timeoutError)throw timeoutError;if(error instanceof ModelTransportError)throw error;
    if(signal?.aborted)throw new ModelTransportError('AGENT_MODEL_CANCELLED','本次模型请求已取消');
    if(['ENOTFOUND','EAI_AGAIN'].includes(error.code))throw new ModelTransportError('AGENT_MODEL_DNS','无法解析模型服务地址，请检查接口域名');
    throw new ModelTransportError(received?'AGENT_MODEL_STREAM_INTERRUPTED':'AGENT_MODEL_NETWORK',received?'模型流在结束前中断，未收到完整工具调用':'无法建立模型连接，请检查模型服务网络');
  }finally{
    clearTimeout(total);clearTimeout(headerTimer);clearTimeout(firstTimer);clearTimeout(idleTimer);clearTimeout(flushTimer);signal?.removeEventListener('abort',abort);response?.destroy();req?.destroy();
  }
}
