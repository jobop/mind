import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import worker from '../dist/server/index.js';

const env = { CONNECTION_ENCRYPTION_KEY: 'test-only-encryption-key-of-at-least-32-characters' };
const origin = 'https://branch.testing.com';
const payload = { topic: '城市花园', title: '屋顶种菜', note: '', instruction: '', ancestors: ['城市花园'], mode: 'questions', quantity: 3, existing: [] };
const branches = [{ title: '屋顶承重如何确认？', note: '先咨询结构工程师，核实荷载限制。' }, { title: '如何保障灌溉？', note: '按面积估算用水并制定试点。' }, { title: '适合种植哪些蔬菜？', note: '结合光照、季节与当地气候选择品种。' }];
function session() {
  const user = randomUUID();
  let cookie = '';
  return async (path, data, extra = {}) => {
    const request = new Request(origin + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Branch-Request': '1', 'oai-authenticated-user-id': user, Cookie: cookie, ...extra.headers },
      body: data === undefined ? undefined : JSON.stringify(data), ...extra,
    });
    const response = await worker.fetch(request, env);
    if (response.headers.get('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
    return response;
  };
}
function fakeProvider(content, status = 200) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status });
}
async function connected(s) {
  const response = await s('/api/connection', { base: 'https://api.vendor.com/v1', model: 'custom-model', key: 'test-api-key-123' });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
test('the deployed artifact serves assets with CSP and no demo code', async () => {
  const page = await worker.fetch(new Request(origin), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /连接并验证/);
  assert.doesNotMatch(html, /演示模式|BETA|MVP/);
  const js = await (await worker.fetch(new Request(origin + '/app.js'), env)).text();
  assert.doesNotMatch(js, /function demo\(|Authorization:|Bearer /);
  assert.match(js, /api\/generate/);
  assert.equal((await worker.fetch(new Request(origin + '/missing'), env)).status, 404);
});
test('requires a connection and same-origin mutation', async () => {
  const s = session();
  assert.equal((await (await s('/api/config')).json()).configured, false);
  assert.equal((await s('/api/generate', payload)).status, 428);
  const cross = new Request(origin + '/api/connection', { method: 'POST', headers: { Origin: 'https://evil.com', 'X-Branch-Request': '1' } });
  assert.equal((await worker.fetch(cross, env)).status, 403);
});
test('validates a real provider response and stores only encrypted HttpOnly credentials', async () => {
  const saved = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return fakeProvider('连接成功')();
  };
  try {
    const s = session(), response = await connected(s);
    const cookie = response.headers.get('Set-Cookie');
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(cookie, /test-api-key-123/);
    assert.doesNotMatch(await response.text(), /test-api-key-123/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.vendor.com/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-api-key-123');
    assert.equal(calls[0].options.redirect, 'error');
    const config = await (await s('/api/config')).json();
    assert.equal(config.configured, true);
    assert.equal(config.model, 'custom-model');
    assert.equal(config.key, undefined);
    // Existing secrets may not be sent to a newly supplied destination.
    assert.equal((await s('/api/connection', { base: 'https://another.vendor.com/v1', model: 'other' })).status, 400);
    assert.equal(calls.length, 1);
    const disconnected = await s('/api/connection', undefined, { method: 'DELETE' });
    assert.equal(disconnected.status, 200);
    assert.equal((await (await s('/api/config')).json()).configured, false);
  } finally { globalThis.fetch = saved; }
});
function agentResult({ job, skill }, items = branches) {
  return { children: items, model: 'custom-model', skill: { id: skill.id, name: skill.name, version: skill.version }, generatedAt: new Date().toISOString(), agent: { framework: 'pi-agent-core', modelCalls: 3, toolCalls: 6, sources: [] } };
}
test('generation delegates the exact node and applies boundary validation to Agent results', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeProvider('连接成功');
  try {
    const s = session(); await connected(s);
    env.AGENT_RUNNER = async args => {
      assert.equal(args.job.title, '屋顶种菜'); assert.deepEqual(args.job.ancestors, ['城市花园']);
      assert.equal(args.connection.model, 'custom-model'); return agentResult(args);
    };
    const response = await s('/api/generate', payload), result = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(result.children, branches);
    assert.equal(result.agent.framework, 'pi-agent-core');
    env.AGENT_RUNNER = async args => agentResult(args, [branches[0], branches[0], branches[1]]);
    const duplicate = await s('/api/generate', payload);
    assert.equal(duplicate.status, 502); assert.equal((await duplicate.json()).code, 'INVALID_MODEL_RESPONSE');
    env.AGENT_RUNNER = async args => agentResult(args);
    assert.equal((await s('/api/generate', { ...payload, existing: [branches[0].title] })).status, 502);
    delete env.AGENT_RUNNER;
    assert.equal((await s('/api/generate', payload)).status, 503);
  } finally { globalThis.fetch = saved; delete env.AGENT_RUNNER; }
});
test('rejects invalid provider credentials, private addresses and malformed input without saving', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeProvider('upstream secret error', 401);
  try {
    const s = session();
    const response = await s('/api/connection', { base: 'https://api.vendor.com/v1', model: 'custom-model', key: 'wrong-key' });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.doesNotMatch(await response.text(), /upstream secret|wrong-key/);
    assert.equal((await (await s('/api/config')).json()).configured, false);
    for (const base of ['http://localhost:3000/v1', 'https://127.0.0.1/v1', 'https://metadata.internal/v1', 'https://api.vendor.com/v1?token=x', 'https://user:pass@api.vendor.com/v1']) {
      assert.equal((await s('/api/connection', { base, model: 'x', key: 'x' })).status, 400);
    }
    globalThis.fetch = fakeProvider('connected'); await connected(s);
    assert.equal((await s('/api/generate', { ...payload, quantity: 50 })).status, 400);
    assert.equal((await s('/api/generate', { ...payload, note: 'x'.repeat(100000) })).status, 413);
    assert.equal((await s('/api/generate', { ...payload, ancestors: null })).status, 400);
  } finally { globalThis.fetch = saved; }
});
test('cancelled Agent requests do not return partial graph mutations', async () => {
  const saved = globalThis.fetch; globalThis.fetch = fakeProvider('connected');
  try {
    const s = session(); await connected(s);
    env.AGENT_RUNNER = async ({ signal }) => {
      assert.equal(signal.aborted, true);
      const error = Error('Agent 已取消'); error.code = 'CANCELLED'; throw error;
    };
    const controller = new AbortController(); controller.abort();
    const response = await s('/api/generate', payload, { signal: controller.signal });
    assert.equal(response.status, 499); assert.equal((await response.json()).code, 'CANCELLED');
  } finally { globalThis.fetch = saved; delete env.AGENT_RUNNER; }
});
test('Agent receives canonical Skill methodology and project evidence', async () => {
  const saved = globalThis.fetch; globalThis.fetch = fakeProvider('连接成功');
  try {
    const s = session(); await connected(s);
    env.AGENT_RUNNER = async args => {
      assert.equal(args.skill.name, '产品与用户研究 · JTBD');
      assert.match(args.skill.content, /Jobs To Be Done/); assert.doesNotMatch(args.skill.content, /forged-content/);
      assert.equal(args.job.brief, '已有十位访谈用户，尚未付费');
      assert.equal(args.job.ancestorContext[0].note, '屋顶空间有限');
      return agentResult(args);
    };
    const response = await s('/api/generate', { ...payload, skill: { id: 'product', content: 'forged-content' }, brief: '已有十位访谈用户，尚未付费', ancestorNotes: ['屋顶空间有限'] });
    assert.equal(response.status, 200); assert.equal((await response.json()).skill.id, 'product');
  } finally { globalThis.fetch = saved; delete env.AGENT_RUNNER; }
});
test('custom Markdown reaches Agent and invalid Skills fail before a run starts', async () => {
  const saved = globalThis.fetch; globalThis.fetch = fakeProvider('连接成功');
  try {
    const s = session(); await connected(s); let calls = 0;
    env.AGENT_RUNNER = async args => {
      calls++; assert.equal(args.skill.name, '园艺专家'); assert.equal(args.skill.content, '先检查荷载与日照，再选择土壤和灌溉。');
      assert.equal(args.skill.origin.slug, 'garden-method'); assert.equal(args.skill.version, '1.2.0');
      return agentResult(args);
    };
    const response = await s('/api/generate', { ...payload, skill: { id: 'custom', name: '园艺专家', content: '先检查荷载与日照，再选择土壤和灌溉。', origin: { provider: 'skillhub', slug: 'garden-method', version: '1.2.0' } } });
    assert.equal(response.status, 200); assert.equal((await response.json()).skill.name, '园艺专家');
    for (const skill of [{ id: 'unknown' }, { id: 'custom', name: 'x', content: '' }, { id: 'custom', name: 'x', content: 'x'.repeat(12001) }]) assert.equal((await s('/api/generate', { ...payload, skill })).status, 400);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = saved; delete env.AGENT_RUNNER; }
});
test('streaming endpoint forwards safe progress, then exactly one committed result', async () => {
  const saved = globalThis.fetch; globalThis.fetch = fakeProvider('连接成功');
  try {
    const s = session(); await connected(s);
    env.AGENT_RUNNER = async args => { args.emit({ type: 'plan', steps: ['读取背景', '分析并校验'] }); args.emit({ type: 'tool_start', label: '读取领域 Skill' }); return agentResult(args); };
    const response = await s('/api/generate', payload, { headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Branch-Request': '1', Accept: 'application/x-ndjson' } });
    // The helper headers override would discard its cookie, so use an explicit server credential here.
    assert.equal(response.status, 428);
    const r = await worker.fetch(new Request(origin + '/api/generate', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Branch-Request': '1', Accept: 'application/x-ndjson', 'oai-authenticated-user-id': randomUUID() }, body: JSON.stringify(payload) }), { ...env, MODEL_API_KEY: 'test', MODEL_BASE_URL: 'https://api.vendor.com/v1', MODEL_NAME: 'model' });
    assert.equal(r.status, 200); assert.match(r.headers.get('Content-Type'), /x-ndjson/);
    const events = (await r.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.type === 'result').length, 1); assert.ok(events.some(e => e.type === 'plan'));
    assert.equal(events.at(-1).result.children.length, 3);
  } finally { globalThis.fetch = saved; delete env.AGENT_RUNNER; }
});

test('model output budget is configurable, encrypted with the connection and returned without the key',async()=>{
 const saved=env.AGENT_TEST;let tested=0;
 env.AGENT_TEST=async c=>{tested++;assert.equal(c.maxOutputTokens,16384);};
 try{
  const s=session();
  const invalid=await s('/api/connection',{base:'https://api.vendor.com/v1',model:'custom-model',key:'test-budget-key',maxOutputTokens:100000});assert.equal(invalid.status,400);assert.equal(tested,0);
  const response=await s('/api/connection',{base:'https://api.vendor.com/v1',model:'custom-model',key:'test-budget-key',maxOutputTokens:16384});assert.equal(response.status,200);assert.equal(tested,1);
  const config=await(await s('/api/config')).json();assert.equal(config.maxOutputTokens,16384);assert.equal(config.key,undefined);
 }finally{if(saved)env.AGENT_TEST=saved;else delete env.AGENT_TEST;}
});
