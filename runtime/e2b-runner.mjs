import {REFERENCE_LIMITS,referenceRequest,referenceKey} from './reference-policy.mjs';
import { platformE2BKey } from './platform-config.mjs';
import { Sandbox } from 'e2b';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { brokerModel, modelHttpError, ModelTransportError } from './model-transport.mjs';
import { readPublicPage, PublicPageError } from './public-page.mjs';
import { AgentRunError } from './pi-agent.mjs';
export { brokerModel };
let active = 0;
const allowedEvents = new Set(['started','plan','model_request','tool_start','tool_end','tool_recovered','source','validation','completed','skill_catalog','skill_selected','sandbox_ready','finishing','map_context','skill_cache','reference_read','reference_cache','resource_status','model_retry']);
export async function runE2BAgent({ apiKey, template, runtimeArchive, connection, job, skills, signal, emit = () => {}, sandboxFactory = options => Sandbox.create(options), modelProxy = brokerModel, pageReader = readPublicPage, referenceReader }) {
  apiKey = platformE2BKey(apiKey);
  if (!apiKey) throw new AgentRunError('平台尚未配置 E2B 沙箱，请联系维护者配置 E2B_API_KEY', 'AGENT_SANDBOX_NOT_CONFIGURED');
  if (active >= 3) throw new AgentRunError('平台沙箱繁忙，请稍后重试', 'AGENT_SANDBOX_BUSY');
  if (!Array.isArray(skills) || !skills.length) throw new AgentRunError('项目尚未准备 Skill 文件', 'AGENT_NO_SKILLS');
  signal?.throwIfAborted(); active++;
  let sandbox, handle, closed = false, result, failure, buffer = '', chain = Promise.resolve(), modelCalls = 0, pages = 0, referenceReads = 0, referenceCalls = 0, eventCount = 0;
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 1080000);
  const abort = () => { if (sandbox) sandbox.kill({ requestTimeoutMs: 10000, signal: AbortSignal.timeout(10000) }).catch(() => {}); };
  controller.signal.addEventListener('abort', abort, { once: true });
  const referenceCache=new Map();
  const modelControllers = new Map(); let lastModelFailure = null;
  const send = message => handle.sendStdin(JSON.stringify(message) + '\n', { requestTimeoutMs: 60000, signal: controller.signal });
  async function processLine(line) {
    if (closed || !line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === 'rpc') {
      let response;
      try {
        if (message.operation === 'model') {
          if (++modelCalls > 20) throw Error('模型请求次数超过限制');
          const modelController = new AbortController(); modelControllers.set(message.id, modelController);
          let sequence = 0, announced = false;
          try {
            response = await modelProxy(connection, message.payload?.body, AbortSignal.any([controller.signal,modelController.signal]), async event => {
              if (modelController.signal.aborted) return;
              if (event.type === 'start') await send({type:'rpc_stream_start',id:message.id,status:event.status,contentType:event.contentType});
              if (event.type === 'chunk') {
                if (!announced) { emit({type:'model_stream',call:modelCalls}); announced=true; }
                await send({type:'rpc_stream_chunk',id:message.id,sequence:++sequence,data:event.data.toString('base64')});
              }
            });
            if (response.status >= 400) lastModelFailure = modelHttpError(response.status); else lastModelFailure = null;
          } finally { modelControllers.delete(message.id); }
        } else if (message.operation === 'page') {
          if (++pages > 5) throw Error('网页请求次数超过限制');
          response = await pageReader(message.payload?.url, controller.signal);
        } else if (message.operation === 'reference') {
          if(++referenceCalls>64)throw Error('参考资源请求次数超过限制');
          const request=referenceRequest(message.payload||{}),id=request.id,key=referenceKey(request);
          if(!referenceReader || !job.mapContext?.nodes.some(n=>n.resources?.some(r=>r.id===id))) throw Error('资源未加入本次导图');
          if(!referenceCache.has(key)){
            if(referenceReads>=REFERENCE_LIMITS.reads)throw Error('不同资源路径已达到读取预算');
            referenceReads++;
            referenceCache.set(key,Promise.resolve().then(()=>referenceReader(id,{path:request.path,directory:request.directory,signal:controller.signal})));
          }
          response=await referenceCache.get(key);
        } else throw Error('未知沙箱请求');
        await send({ type: 'rpc_result', id: message.id, result: response });
      } catch (error) {
        const known = error instanceof ModelTransportError || error instanceof PublicPageError;
        const messageText = known ? error.message : message.operation === 'model' ? '模型代理调用未完成，请检查连接和任务预算' : message.operation === 'reference' ? '参考资源读取失败，请检查链接、仓库分支、凭证或文件是否仍在项目中' : '公开网页读取未完成';
        if (message.operation === 'model') { lastModelFailure = known ? error : new ModelTransportError('AGENT_MODEL_PROXY',messageText); emit({type:'model_error',code:lastModelFailure.code,reason:messageText}); }
        await send({type:'rpc_result',id:message.id,error:messageText,code:known?error.code:message.operation==='model'?'AGENT_MODEL_PROXY':'AGENT_TOOL_PROXY'});
      }
    } else if (message.type === 'result') {
      if (Buffer.byteLength(JSON.stringify(message.result)) > 600000) throw Error('任务结果超过限制');
      result = message.result;
    } else if (message.type === 'error') {
      const known = ['AGENT_LIMIT','AGENT_INCOMPLETE','AGENT_TIMEOUT','AGENT_ERROR','AGENT_NO_SKILLS','TOOLS_REQUIRED'].includes(message.code);
      if (lastModelFailure && ['AGENT_INCOMPLETE','AGENT_ERROR'].includes(message.code)) { failure = new AgentRunError(lastModelFailure.message,lastModelFailure.code); return; }
      failure = new AgentRunError(known && typeof message.error === 'string' ? message.error.slice(0, 240) : '沙箱 Agent 未完成任务，请检查工具记录后重试', known ? message.code : 'AGENT_SANDBOX_FAILED');
    }
    else if (allowedEvents.has(message.type) && eventCount++ < 250) emit(message);
  }
  try {
    emit({ type: 'sandbox_creating', provider: 'e2b' });
    // Each call creates a new VM. No snapshot/fork of a previous user's task is used.
    sandbox = await sandboxFactory({ apiKey, ...(template ? { template } : {}), timeoutMs: 1200000, requestTimeoutMs: 60000, idempotencyKey: randomUUID(), allowInternetAccess: false, network: { allowPublicTraffic: false }, metadata: { application: 'mind', project: job.project.id } });
    controller.signal.throwIfAborted();
    emit({ type: 'sandbox_created', provider: 'e2b', taskId: sandbox.sandboxId });
    const archive = await readFile(runtimeArchive);
    await sandbox.files.write('/home/user/mind-runtime.tar.gz', archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), { requestTimeoutMs: 90000, signal: controller.signal });
    await sandbox.commands.run('mkdir -p /opt/mind-agent /workspace/task && tar -xzf /home/user/mind-runtime.tar.gz -C /opt/mind-agent && rm -f /home/user/mind-runtime.tar.gz && chown -R user:user /workspace/task && /opt/mind-agent/bin/node --version', { user: 'root', timeoutMs: 60000, signal: controller.signal });
    handle = await sandbox.commands.run('exec /opt/mind-agent/bin/node /opt/mind-agent/runtime/sandbox-task.mjs', { user: 'user', background: true, stdin: true, timeoutMs: 930000, retainOutput: false, signal: controller.signal, onStderr: () => {}, onStdout: chunk => {
      buffer += chunk;

      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 24 * 1024 * 1024) { failure = new AgentRunError('单条沙箱消息超过平台限制（24 MiB）', 'AGENT_SANDBOX_FAILED'); controller.abort(); return; }
        try { const message = JSON.parse(line); if (message.type === 'rpc_cancel') { modelControllers.get(message.id)?.abort({code:message.reason==='consumer_done'?'MODEL_CONSUMER_DONE':'MODEL_REQUEST_ABORTED'}); continue; } } catch {}
        chain = chain.then(() => processLine(line)).catch(() => { failure = new AgentRunError('沙箱通信失败', 'AGENT_SANDBOX_FAILED'); controller.abort(); }); }
      if (Buffer.byteLength(buffer) > 24 * 1024 * 1024) { failure = new AgentRunError('单条沙箱消息超过平台限制（24 MiB）', 'AGENT_SANDBOX_FAILED'); controller.abort(); }
    } });
    await sandbox.files.write('/workspace/task/input.json', JSON.stringify({ connection: { url: connection.url, model: connection.model, key: 'brokered-no-real-key', maxOutputTokens: connection.maxOutputTokens, visionEnabled: connection.visionEnabled===true }, job, skills }), { requestTimeoutMs: 60000, signal: controller.signal });
    await send({ type: 'start' });
    let exitError;
    try { await handle.wait(); } catch (error) { exitError = error; }
    await chain;
    if (failure) throw failure;
    controller.signal.throwIfAborted();
    if (exitError || !result) throw new AgentRunError('沙箱未提交完整结果，原导图已保留', 'AGENT_SANDBOX_FAILED');
    return { ...result, agent: { ...result.agent, sandbox: { provider: 'e2b', taskId: sandbox.sandboxId, isolated: true } } };
  } catch (error) {
    if (signal?.aborted) throw new AgentRunError('任务已取消，沙箱正在清理', 'CANCELLED');
    if (error instanceof AgentRunError) throw error;
    throw new AgentRunError(controller.signal.aborted ? '沙箱任务超时，原导图已保留' : '无法启动或连接 E2B 沙箱，请维护者检查平台配置、模板与额度', 'AGENT_SANDBOX_FAILED');
  } finally {
    closed = true; clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', abort);
    if (sandbox) {
      let destroyed = false;
      for (let n = 0; n < 3 && !destroyed; n++) { try { await sandbox.kill({ requestTimeoutMs: 10000, signal: AbortSignal.timeout(10000) }); destroyed = true; } catch {} }
      emit({ type: destroyed ? 'sandbox_destroyed' : 'sandbox_cleanup_pending', provider: 'e2b', taskId: sandbox.sandboxId });
    }
    active--;
  }
}
