import { Sandbox } from 'e2b';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isPublicAddress, publicUrl, readPublicPage } from './public-page.mjs';
import { AgentRunError } from './pi-agent.mjs';

// Credentialed model traffic is brokered on the server; keys never enter the sandbox.
export async function brokerModel(connection, raw, signal) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) throw Error('模型请求超过限制');
  const input = JSON.parse(raw);
  if (!Array.isArray(input.messages) || !Array.isArray(input.tools)) throw Error('模型工具请求格式不正确');
  const url = publicUrl(connection.url), addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw Error('模型地址必须指向公网服务');
  const payload = JSON.stringify({ ...input, model: connection.model, stream: true, max_tokens: Math.min(Number(input.max_tokens) || 3600, 3600) });
  const combined = AbortSignal.any([signal, AbortSignal.timeout(45000)]), address = addresses[0];
  return new Promise((done, fail) => {
    const request = https.request(url, { method: 'POST', signal: combined, agent: false,
      lookup(host, options, callback) { options.all ? callback(null, [address]) : callback(null, address.address, address.family); },
      headers: { Authorization: 'Bearer ' + connection.key, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(Error('模型响应超过限制')); else chunks.push(chunk); });
      response.on('error', fail);
      response.on('end', () => done({ status: response.statusCode, contentType: response.headers['content-type'] || 'text/plain', body: response.statusCode >= 200 && response.statusCode < 300 ? Buffer.concat(chunks).toString('utf8').split(connection.key).join('[redacted]') : JSON.stringify({ error: { message: '模型服务返回 HTTP ' + response.statusCode } }) }));
    });
    request.on('error', fail); request.end(payload);
  });
}
let active = 0;
const allowedEvents = new Set(['started','plan','model_request','tool_start','tool_end','tool_recovered','source','validation','completed','skill_catalog','skill_selected','sandbox_ready']);
export async function runE2BAgent({ apiKey, template, runtimeArchive, connection, job, skills, signal, emit = () => {}, sandboxFactory = options => Sandbox.create(options), modelProxy = brokerModel, pageReader = readPublicPage }) {
  if (!apiKey) throw new AgentRunError('平台尚未配置 E2B 沙箱，请联系维护者配置 E2B_API_KEY', 'AGENT_SANDBOX_NOT_CONFIGURED');
  if (active >= 3) throw new AgentRunError('平台沙箱繁忙，请稍后重试', 'AGENT_SANDBOX_BUSY');
  if (!Array.isArray(skills) || !skills.length) throw new AgentRunError('项目尚未准备 Skill 文件', 'AGENT_NO_SKILLS');
  signal?.throwIfAborted(); active++;
  let sandbox, handle, closed = false, result, failure, buffer = '', chain = Promise.resolve(), modelCalls = 0, pages = 0, eventCount = 0;
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 270000);
  const abort = () => { if (sandbox) sandbox.kill({ requestTimeoutMs: 10000, signal: AbortSignal.timeout(10000) }).catch(() => {}); };
  controller.signal.addEventListener('abort', abort, { once: true });
  const send = message => handle.sendStdin(JSON.stringify(message) + '\n', { requestTimeoutMs: 60000, signal: controller.signal });
  async function processLine(line) {
    if (closed || !line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === 'rpc') {
      let response;
      try {
        if (message.operation === 'model') {
          if (++modelCalls > 8) throw Error('模型请求次数超过限制');
          response = await modelProxy(connection, message.payload?.body, controller.signal);
        } else if (message.operation === 'page') {
          if (++pages > 5) throw Error('网页请求次数超过限制');
          response = await pageReader(message.payload?.url, controller.signal);
        } else throw Error('未知沙箱请求');
        await send({ type: 'rpc_result', id: message.id, result: response });
      } catch { await send({ type: 'rpc_result', id: message.id, error: '平台代理请求未成功，可能是超时、访问限制或执行预算不足' }); }
    } else if (message.type === 'result') {
      if (Buffer.byteLength(JSON.stringify(message.result)) > 600000) throw Error('任务结果超过限制');
      result = message.result;
    } else if (message.type === 'error') failure = new AgentRunError('沙箱 Agent 未完成任务，请检查工具记录后重试', 'AGENT_SANDBOX_FAILED');
    else if (allowedEvents.has(message.type) && eventCount++ < 100) emit(message);
  }
  try {
    emit({ type: 'sandbox_creating', provider: 'e2b' });
    // Each call creates a new VM. No snapshot/fork of a previous user's task is used.
    sandbox = await sandboxFactory({ apiKey, ...(template ? { template } : {}), timeoutMs: 300000, requestTimeoutMs: 60000, idempotencyKey: randomUUID(), allowInternetAccess: false, network: { allowPublicTraffic: false }, metadata: { application: 'mind', project: job.project.id } });
    controller.signal.throwIfAborted();
    emit({ type: 'sandbox_created', provider: 'e2b', taskId: sandbox.sandboxId });
    const archive = await readFile(runtimeArchive);
    await sandbox.files.write('/home/user/mind-runtime.tar.gz', archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), { requestTimeoutMs: 90000, signal: controller.signal });
    await sandbox.commands.run('mkdir -p /opt/mind-agent /workspace/task && tar -xzf /home/user/mind-runtime.tar.gz -C /opt/mind-agent && rm -f /home/user/mind-runtime.tar.gz && chown -R user:user /workspace/task && /opt/mind-agent/bin/node --version', { user: 'root', timeoutMs: 60000, signal: controller.signal });
    handle = await sandbox.commands.run('exec /opt/mind-agent/bin/node /opt/mind-agent/runtime/sandbox-task.mjs', { user: 'user', background: true, stdin: true, timeoutMs: 200000, retainOutput: false, signal: controller.signal, onStderr: () => {}, onStdout: chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { failure = new AgentRunError('沙箱消息超过限制', 'AGENT_SANDBOX_FAILED'); controller.abort(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); chain = chain.then(() => processLine(line)).catch(() => { failure = new AgentRunError('沙箱通信失败', 'AGENT_SANDBOX_FAILED'); controller.abort(); }); }
    } });
    await sandbox.files.write('/workspace/task/input.json', JSON.stringify({ connection: { url: connection.url, model: connection.model, key: 'brokered-no-real-key' }, job, skills }), { requestTimeoutMs: 60000, signal: controller.signal });
    await send({ type: 'start' });
    let exitError;
    try { await handle.wait(); } catch (error) { exitError = error; }
    await chain;
    controller.signal.throwIfAborted();
    if (failure) throw failure;
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
