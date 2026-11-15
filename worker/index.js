const COOKIE = '__Host-branch-connection';
const SESSION_AGE = 7 * 24 * 60 * 60;
const MAX_BODY = 96000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const requests = new Map();
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function asText(value, name, max, required = true) {
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new AppError(name + '格式不正确');
  return value.trim();
}
function endpoint(value) {
  const raw = asText(value, '接口地址', 500);
  let url;
  try { url = new URL(raw); } catch { throw new AppError('请输入完整的 HTTPS 接口地址'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' ||
      !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|internal|lan|test|invalid|example)$/.test(host)) {
    throw new AppError('请使用公网 HTTPS 接口，不支持本机、内网地址或带参数的 URL');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
  return url.href;
}
async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new AppError('需要 JSON 请求', 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw new AppError('请求内容过长', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('请求内容为空');
  let size = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new AppError('请求内容过长', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const result = JSON.parse(decoder.decode(bytes));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw Error();
    return result;
  } catch { throw new AppError('请求 JSON 格式不正确'); }
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function encryptionKey(env) {
  if (typeof env.CONNECTION_ENCRYPTION_KEY !== 'string' || env.CONNECTION_ENCRYPTION_KEY.length < 32) {
    throw new AppError('服务端连接存储尚未配置，请联系站点维护者', 503, 'SERVER_NOT_READY');
  }
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(env.CONNECTION_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(connection, request, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ ...connection, expires: Date.now() + SESSION_AGE * 1000, owner: env.PROJECT_SERVICE ? env.PROJECT_SERVICE.user(request).id : request.headers.get('oai-authenticated-user-id') || '' }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(new URL(request.url).origin) }, await encryptionKey(env), plaintext);
  return b64(iv) + '.' + b64(new Uint8Array(ciphertext));
}
async function connection(request, env, required = true) {
  const cookie = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (cookie && cookie.length < 4000) {
    try {
      const [iv, cipher] = cookie.split('.');
      const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(new URL(request.url).origin) }, await encryptionKey(env), unb64(cipher));
      const data = JSON.parse(decoder.decode(result));
      if (data.expires > Date.now() && data.owner === (env.PROJECT_SERVICE ? env.PROJECT_SERVICE.user(request, false)?.id : request.headers.get('oai-authenticated-user-id') || '')) return { ...data, source: 'session' };
    } catch { /* An expired or invalid session must never expose credentials. */ }
  }
  if (env.MODEL_API_KEY && env.MODEL_BASE_URL && env.MODEL_NAME) {
    return { key: env.MODEL_API_KEY, url: endpoint(env.MODEL_BASE_URL), model: env.MODEL_NAME, source: 'server' };
  }
  if (required) throw new AppError('请先在模型设置中连接并验证接口', 428, 'CONNECTION_REQUIRED');
  return null;
}
function publicConnection(c) {
  return c ? { configured: true, visionEnabled: c.visionEnabled === true, maxOutputTokens: c.maxOutputTokens || 8192, model: c.model, base: c.url.replace(/\/chat\/completions$/, ''), source: c.source, expires: c.expires || null } : { configured: false };
}
function checkOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('X-Branch-Request') !== '1') {
    throw new AppError('请求来源验证失败，请刷新页面后重试', 403, 'INVALID_ORIGIN');
  }
}
function acquire(request, env) {
  const id = env?.PROJECT_SERVICE?.user(request, false)?.id || request.headers.get('oai-authenticated-user-id') || request.headers.get('CF-Connecting-IP') || 'private-owner';
  const now = Date.now();
  if (requests.size > 1000) for (const [key, value] of requests) if (now - value.start > 120000) requests.delete(key);
  let state = requests.get(id);
  if (!state || now - state.start > 60000) state = { start: now, count: 0, active: false };
  if (state.active) throw new AppError('已有请求正在生成，请稍后重试', 429, 'BUSY');
  if (state.count >= 15) throw new AppError('请求较频繁，请稍等一分钟再试', 429, 'RATE_LIMITED');
  state.count++; state.active = true; requests.set(id, state);
  return () => { state.active = false; };
}
async function completion(c, messages, request, { test = false, retry = false } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(cancel, test ? 25000 : 65000);
  try {
    let upstream;
    try {
      upstream = await fetch(c.url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
        body: JSON.stringify({ model: c.model, stream: false, max_tokens: test ? 64 : (c.maxOutputTokens || 8192), messages }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new AppError(request.signal.aborted ? '生成已取消' : '模型响应超时，请重试或更换模型', 504, 'TIMEOUT');
      throw new AppError('无法连接模型服务，请检查接口地址及服务可用性', 502, 'UPSTREAM_NETWORK');
    }
    if (!upstream.ok) {
      const status = upstream.status;
      await upstream.body?.cancel();
      if (status === 401 || status === 403) throw new AppError('模型服务拒绝访问，请检查 API Key 与账户权限', 422, 'INVALID_CREDENTIAL');
      if (status === 404) throw new AppError('接口或模型不存在，请检查 Base URL 与模型名', 422, 'MODEL_NOT_FOUND');
      if (status === 402) throw new AppError('模型账户额度不足，请检查余额', 422, 'QUOTA_EXCEEDED');
      if (status === 429) throw new AppError('模型服务限流或额度不足，请稍后重试', 429, 'UPSTREAM_RATE_LIMITED');
      throw new AppError('模型服务返回错误（HTTP ' + status + '），请检查服务配置后重试', 502, 'UPSTREAM_ERROR');
    }
    // Bound response size and keep the timeout active while reading a streamed HTTP body.
    const reader = upstream.body.getReader();
    let text = '', bytes = 0;
    const utf8 = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512000) { await reader.cancel(); throw new AppError('模型响应过长，请换用其他模型', 502, 'INVALID_MODEL_RESPONSE'); }
      text += utf8.decode(value, { stream: true });
    }
    text += utf8.decode();
    let data;
    try { data = JSON.parse(text); } catch { throw new AppError('接口没有返回 Chat Completions JSON 数据', 502, 'INVALID_MODEL_RESPONSE'); }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AppError('模型没有返回文本，请检查模型是否支持 Chat Completions', 502, 'INVALID_MODEL_RESPONSE');
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) throw new AppError(request.signal.aborted ? '生成已取消' : '模型响应超时，请重试', 504, 'TIMEOUT');
    throw new AppError('读取模型响应失败，请重试', 502, 'UPSTREAM_NETWORK');
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', cancel);
  }
}
function parseBranches(content, quantity, existing) {
  let text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(text); } catch { throw new AppError('模型未返回有效的结构化内容，请重试', 502, 'INVALID_MODEL_RESPONSE'); }
  const children = result?.children;
  if (!Array.isArray(children) || children.length !== quantity) throw new AppError('模型返回的分支数量不正确，请重试', 502, 'INVALID_MODEL_RESPONSE');
  const seen = new Set(existing.map(t => t.trim().toLocaleLowerCase()));
  return children.map(c => {
    if (!c || typeof c.title !== 'string' || !c.title.trim() || c.title.trim().length > 80 || typeof c.note !== 'string' || c.note.length > 3000) {
      throw new AppError('模型返回的节点格式不正确，请重试', 502, 'INVALID_MODEL_RESPONSE');
    }
    const title = c.title.trim(), key = title.toLocaleLowerCase();
    if (seen.has(key)) throw new AppError('模型返回了重复分支，请重试', 502, 'INVALID_MODEL_RESPONSE');
    seen.add(key);
    return { title, note: c.note.trim() };
  });
}
async function route(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/healthz' && ['GET','HEAD'].includes(request.method)) return json({ status: 'ok', version: '3.3.1', agent: typeof env.AGENT_RUNNER === 'function', release: env.RELEASE_SHA || null, sandbox: { provider: 'e2b', configured: !!env.SANDBOX_CONFIGURED } }, typeof env.AGENT_RUNNER === 'function' ? 200 : 503);
  if (!path.startsWith('/api/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: '不支持的请求方法' }, 405);
    const asset = ASSETS[path === '/index.html' ? '/' : path];
    return asset ? new Response(request.method === 'HEAD' ? null : asset.body, { headers: { ...headers, 'Content-Type': asset.type } }) : new Response('Not found', { status: 404, headers });
  }
  if (env.RESOURCE_SERVICE && /^\/api\/projects\/[^/]+\/(?:resources|git-credentials)(?:\/|$)/.test(path)) return env.RESOURCE_SERVICE.handle(request);
  if (env.PROJECT_SERVICE && (path.startsWith('/api/auth/') || path === '/api/projects' || path.startsWith('/api/projects/'))) return env.PROJECT_SERVICE.handle(request);
  if (path === '/api/config' && request.method === 'GET') {
    return json({ ...publicConnection(await connection(request, env, false)), user: env.PROJECT_SERVICE?.user(request, false) || null, projectsEnabled: !!env.PROJECT_SERVICE, backgroundJobs: !!env.GENERATION_JOBS, sandbox: { provider: 'e2b', configured: !!env.SANDBOX_CONFIGURED }, version: '3.3.1', agent: { available: typeof env.AGENT_RUNNER === 'function', framework: 'pi-agent-core', version: '1.5.2' }, canSave: typeof env.CONNECTION_ENCRYPTION_KEY === 'string' && env.CONNECTION_ENCRYPTION_KEY.length >= 32 });
  }
  if (env.PROJECT_SERVICE) env.PROJECT_SERVICE.user(request);
  if (env.GENERATION_JOBS && (path === '/api/generation-jobs' || path.startsWith('/api/generation-jobs/'))) return env.GENERATION_JOBS.handle(request);
  if (path.startsWith('/api/skillhub/')) return skillHubRoute(request, env);
  checkOrigin(request);
  if (path === '/api/connection' && request.method === 'DELETE') {
    return json({ configured: false }, 200, { 'Set-Cookie': COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  if (path === '/api/connection' && request.method === 'POST') {
    const input = await body(request);
    const url = endpoint(input.base);
    const model = asText(input.model, '模型名', 150);
    if (/[\x00-\x1f\x7f]/.test(model)) throw new AppError('模型名含有无效字符');
    let key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!key) {
      const previous = await connection(request, env, false);
      // An existing secret must never be forwarded to a newly entered host.
      if (!previous || previous.url !== url) throw new AppError('更换接口地址时，请重新填写 API Key');
      key = previous.key;
    }
    if (key.length > 1000 || /[\s\x00-\x1f\x7f]/.test(key)) throw new AppError('API Key 格式不正确');
    await encryptionKey(env);
    const maxOutputTokens = input.maxOutputTokens ?? 8192;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 65536) throw new AppError('输出预算需为 128–65536 的整数，请按服务商支持范围填写');
    const c = { url, model, key, maxOutputTokens, visionEnabled: input.visionEnabled === true };
    const release = acquire(request, env);
    try {
      if (env.AGENT_TEST) await env.AGENT_TEST(c, request.signal);
      else await completion(c, [{ role: 'user', content: '请只回复：连接成功' }], request, { test: true });
    } finally { release(); }
    const cookie = await seal(c, request, env);
    return json({ ...publicConnection({ ...c, source: 'session', expires: Date.now() + SESSION_AGE * 1000 }), verified: true }, 200, {
      'Set-Cookie': COOKIE + '=' + cookie + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + SESSION_AGE,
    });
  }
  if (path === '/api/test' && request.method === 'POST') {
    const c = await connection(request, env);
    const release = acquire(request, env);
    try {
      if (env.AGENT_TEST) await env.AGENT_TEST(c, request.signal);
      else await completion(c, [{ role: 'user', content: '请只回复：连接成功' }], request, { test: true });
    } finally { release(); }
    return json({ ...publicConnection(c), verified: true });
  }
  if (path === '/api/generate' && request.method === 'POST') {
    const c = await connection(request, env);
    const input = await body(request);
    const topic = asText(input.topic, '主题', 80);
    const title = asText(input.title, '当前节点', 80);
    const note = asText(input.note ?? '', '备注', 3000, false);
    const instruction = asText(input.instruction ?? '', '补充说明', 2000, false);
    const project = env.PROJECT_SERVICE ? env.PROJECT_SERVICE.get(request, input.projectId) : null;
    const projectSkills = project?.skills.filter(s => s.enabled !== false);
    if (project && !projectSkills.length) throw new AppError('请先为当前项目添加并启用至少一个 Skill');
    const brief = project ? project.brief : asText(input.brief ?? '', '项目背景', 4000, false);
    const selectedSkill = input.skill ?? { id: 'general' };
    if (!selectedSkill || typeof selectedSkill !== 'object' || Array.isArray(selectedSkill)) throw new AppError('Skill 格式不正确');
    let skill = DOMAIN_SKILLS.find(s => s.id === selectedSkill.id);
    if (selectedSkill.id === 'custom') {
      skill = { id: 'custom', name: asText(selectedSkill.name, 'Skill 名称', 80), content: asText(selectedSkill.content, 'Skill 内容', 12000), version: 'custom' };
      const source = selectedSkill.origin;
      if (source && source.provider === 'skillhub' && typeof source.slug === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(source.slug) &&
          typeof source.version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(source.version)) {
        skill.origin = { provider: 'skillhub', slug: source.slug, version: source.version, modified: source.modified === true };
        skill.version = source.version;
      }
    }
    if (!skill) throw new AppError('未找到所选 Skill，请重新选择');
    if (!Array.isArray(input.ancestorNotes ?? []) || (input.ancestorNotes ?? []).length > 20 || (input.ancestorNotes ?? []).some(t => typeof t !== 'string' || t.length > 3000)) throw new AppError('祖先备注格式不正确');
    // Keep contextual notes bounded without silently truncating the selected methodology.
    const ancestorNotes = input.ancestorNotes ?? [];
    if (!['questions', 'solutions'].includes(input.mode) || ![3, 4, 5].includes(input.quantity)) throw new AppError('生成方向或数量不正确');
    if (!Array.isArray(input.existing) || input.existing.length > 200 || input.existing.some(t => typeof t !== 'string' || t.length > 80)) throw new AppError('已有分支格式不正确');
    if (!Array.isArray(input.ancestors) || input.ancestors.length > 20 || input.ancestors.some(t => typeof t !== 'string' || t.length > 80)) throw new AppError('节点路径格式不正确');
    if (typeof env.AGENT_RUNNER !== 'function') throw new AppError('Pi Agent 运行时未启动，请使用 ZIP 中的启动脚本或 npm start', 503, 'AGENT_NOT_AVAILABLE');
    const providedSources = input.providedSources ?? [];
    if (!Array.isArray(providedSources) || providedSources.length > 5 || providedSources.some(s => !s || typeof s.url !== 'string' || s.url.length > 2000 || typeof s.title !== 'string' || s.title.length > 200)) throw new AppError('参考来源格式不正确');
    const mapContext = project && input.mapId && input.nodeId ? env.PROJECT_SERVICE.mapContext(project,input.mapId,input.nodeId) : null;
    const job = { topic: mapContext?.rootTitle || topic, title: mapContext?.target.title || title, note: mapContext?.target.note || note, mapContext, brief, instruction, mode: input.mode, quantity: input.quantity, existing: input.existing, ancestors: input.ancestors, ancestorContext: input.ancestors.map((name, i) => ({ title: name, note: (ancestorNotes[i] || '').slice(0, 400) })).slice(-8), providedSources };
    const managed = !!env.GENERATION_JOBS && !!input.clientRequestId;
    const release = managed ? () => {} : acquire(request, env);
    const controller = new AbortController();
    let signal = AbortSignal.any([request.signal, controller.signal]);
    async function hubCall(path, payload) {
      const req = new Request(new URL(path, request.url), { method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Branch-Request': '1', Origin: new URL(request.url).origin, 'oai-authenticated-user-id': request.headers.get('oai-authenticated-user-id') || '', 'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '' }, body: payload ? JSON.stringify(payload) : undefined, signal });
      const response = await skillHubRoute(req, env), result = await response.json();
      if (!response.ok) throw Error(result.error || 'SkillHub 请求失败');
      return result;
    }
    const hub = {
      search: keyword => hubCall('/api/skillhub/search?' + new URLSearchParams({ q: keyword })),
      detail: slug => hubCall('/api/skillhub/detail?' + new URLSearchParams({ slug })),
      read: payload => hubCall('/api/skillhub/read', payload),
    };
    async function execute(emit) {
      const result = await env.AGENT_RUNNER({ connection: c, job: { ...job, project: project ? { id: project.id, name: project.name } : null }, skill, skills: projectSkills, signal, hub, emit });
      if (signal.aborted) throw new AppError('Agent 已取消', 499, 'CANCELLED');
      const children = parseBranches(JSON.stringify({ children: result.children }), input.quantity, input.existing);
      if (!result.agent || result.agent.framework !== 'pi-agent-core') throw new AppError('Agent 运行结果缺少框架信息', 502, 'INVALID_AGENT_RESULT');
      return { ...result, children };
    }
    if (managed) {
      return env.GENERATION_JOBS.start(request, input, async (emit, jobSignal) => {
        signal = jobSignal;
        const done = acquire(request, env);
        try { return await execute(emit); } finally { done(); }
      });
    }
    if (request.headers.get('Accept')?.includes('application/x-ndjson')) {
      let closed = false;
      const stream = new ReadableStream({
        start(streamController) {
          const send = value => { if (!closed) streamController.enqueue(encoder.encode(JSON.stringify(value) + '\n')); };
          (async () => {
            try { send({ type: 'connected' }); const result = await execute(send); send({ type: 'result', result }); }
            catch (error) { send({ type: 'error', error: error instanceof AppError || error.code?.startsWith('AGENT') || error.code === 'CANCELLED' || error.code === 'TOOLS_REQUIRED' ? error.message : 'Agent 执行失败，原脑图已保留', code: error.code || 'AGENT_ERROR' }); }
            finally { release(); if (!closed) { closed = true; streamController.close(); } }
          })();
        },
        cancel() { closed = true; controller.abort(); },
      });
      return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } });
    }
    try { return json(await execute(() => {})); }
    finally { release(); }

  }
  return json({ error: '接口不存在', code: 'NOT_FOUND' }, 404);
}
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof AppError || error.status && error.code) return json({ error: error.message, code: error.code }, error.status);
      if (error.code?.startsWith('AGENT') || ['CANCELLED', 'TOOLS_REQUIRED'].includes(error.code)) return json({ error: error.message, code: error.code }, error.code === 'CANCELLED' ? 499 : 502);
      // Do not return provider payloads, request bodies, keys or stack traces.
      return json({ error: '服务暂时不可用，请稍后重试', code: 'INTERNAL_ERROR' }, 500);
    }
  },
};
export { skillHubBundle };
