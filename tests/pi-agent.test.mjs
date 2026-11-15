import { sseMessage } from './fixtures/pi-sse.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPiAgent } from '../runtime/pi-agent.mjs';
import { testPiConnection } from '../runtime/pi-model.mjs';
import { isPublicAddress, publicUrl, pageText, readPublicPage } from '../runtime/public-page.mjs';

const connection = { url: 'https://api.vendor.com/v1/chat/completions', model: 'tool-capable-model', key: 'test-not-a-real-key' };
const job = { topic: '屋顶菜园', title: '灌溉方案', note: '', brief: '预算有限，只有周末有人维护', instruction: '', ancestors: ['屋顶菜园'], ancestorContext: [], existing: [], mode: 'questions', quantity: 3 };
const skill = { id: 'engineering', name: '技术方案', version: '1.0', content: '先识别失效模式，再比较方案与验收条件。' };
const children = ['如何检测滴头堵塞？', '停水期间如何保湿？', '水量如何按作物分配？'].map(title => ({ title, note: '【决策意义】这一条件会影响无人值守时灌溉系统的可靠性，应先明确维护边界并核实现场限制。【验证方式】在小范围原型中记录连续一周的水量与异常，再按实测结果确认设计参数。', sourceIds: ['S1'] }));
const hub = { search: async () => ({ total: 0, items: [] }), detail: async () => ({}), read: async () => ({ documents: [] }) };

const first = [
  { name: 'plan_work', args: { steps: ['读取项目约束与领域方法', '读取公开材料并设计验证问题', '校验并提交分支'] } },
  { name: 'read_node_context', args: {} }, { name: 'read_skill', args: {} },
];
test('Pi SDK executes tools, incorporates their results, repairs invalid output and submits once', async () => {
  const saved = globalThis.fetch, events = [], requests = [];
  const bad = [children[0], children[0], children[2]];
  const script = [first, [{ name: 'read_public_page', args: { url: 'https://garden.org/irrigation' } }], [{ name: 'validate_branches', args: { children: bad } }], [{ name: 'validate_branches', args: { children } }], [{ name: 'submit_branches', args: { children } }]];
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions');
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer ' + connection.key);
    const data = JSON.parse(options.body); requests.push(data);
    assert.equal(data.stream, true); assert.ok(data.tools.some(t => t.function.name === 'read_skill'));
    const calls = script.shift(); assert.ok(calls, 'No extra model request after final submission');
    return sseMessage(calls);
  };
  try {
    const result = await runPiAgent({ connection, job, skill, hub, emit: event => events.push(event), pageReader: async () => ({ url: 'https://garden.org/irrigation', title: '园艺材料', text: '滴灌系统需定期检查堵塞。', fetchedAt: new Date().toISOString() }) });
    assert.equal(result.agent.framework, 'pi-agent-core'); assert.equal(result.agent.version, '1.5.2');
    assert.equal(result.children.length, 3); assert.equal(result.agent.modelCalls, 5);
    assert.equal(result.agent.sources[0].id, 'S1'); assert.match(result.children[0].note, /\[S1\]/);
    assert.ok(events.some(e => e.type === 'validation' && e.valid === false));
    assert.ok(events.some(e => e.type === 'completed'));
    const tools = requests[3].messages.filter(m => m.role === 'tool');
    assert.ok(tools.some(m => m.content.includes('重名')), 'Validation feedback is part of the actual next model request');
    assert.equal(script.length, 0);
  } finally { globalThis.fetch = saved; }
});
test('connection check uses Pi streaming and verifies a real function call rather than text', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.tool_choice.function.name, 'connection_check');
    return sseMessage([{ name: 'connection_check', args: { ok: true } }]);
  };
  try {
    assert.equal((await testPiConnection(connection)).toolCalling, true);
    globalThis.fetch = async () => sseMessage([], connection.model, '连接成功');
    await assert.rejects(testPiConnection(connection), /没有返回有效工具调用/);
  } finally { globalThis.fetch = saved; }
});
test('Pi Agent refuses direct text answers and never falls back to one-shot generation', async () => {
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return sseMessage([], connection.model, '{"children":[]}'); };
  try {
    await assert.rejects(runPiAgent({ connection, job, skill, hub }), /工具协议|未提交|未完成/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = saved; }
});
test('unread Skill, forged evidence and unvalidated submissions cannot become graph nodes', async () => {
  const saved = globalThis.fetch, events = [];
  const forged = children.map(n => ({ ...n, sourceIds: ['S999'] }));
  const script = [[{ name: 'submit_branches', args: { children: forged } }], first, [{ name: 'validate_branches', args: { children: forged } }]];
  globalThis.fetch = async () => sseMessage(script.shift() || [{ name: 'read_skill', args: {} }]);
  try {
    await assert.rejects(runPiAgent({ connection, job, skill, hub, emit: e => events.push(e), limits: { modelCalls: 3, toolCalls: 20, pages: 5, timeoutMs: 5000 } }), e => e.code === 'AGENT_LIMIT');
    assert.ok(events.some(e => e.type === 'tool_end' && e.tool === 'submit_branches' && !e.ok));
    assert.ok(events.some(e => e.type === 'validation' && e.issues.some(i => i.includes('真实证据'))));
  } finally { globalThis.fetch = saved; }
});
test('cancellation stops the SDK provider request and does not return partial nodes', async () => {
  const saved = globalThis.fetch, controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    setTimeout(() => controller.abort(), 10);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  };
  try { await assert.rejects(runPiAgent({ connection, job, skill, hub, signal: controller.signal }), e => e.code === 'CANCELLED'); }
  finally { globalThis.fetch = saved; }
});
test('public-page tool rejects private addresses and extracts text without executing HTML', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '224.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => publicUrl('http://localhost/admin'));
  assert.throws(() => publicUrl('https://user:secret@example.org'));
  assert.deepEqual(pageText('<title>材料 &amp; 来源</title><script>evil()</script><p>正文</p>', 'text/html'), { title: '材料 & 来源', text: '材料 & 来源 正文' });
  await assert.rejects(readPublicPage('https://public.example.org', undefined, { request: async () => ({ location: 'http://127.0.0.1/admin' }) }), /公网 HTTPS/);
  await assert.rejects(readPublicPage('https://public.example.org', undefined, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /内网/);
});

test('invalid plan parameters surface a safe reason and a successful retry marks the failure recovered', async () => {
  const saved = globalThis.fetch, events = [];
  const nodes = children.map(c => ({ ...c, sourceIds: [] }));
  const script = [
    [{ name: 'plan_work', args: { steps: [{}] } }, ...first.slice(1)],
    [first[0], { name: 'validate_branches', args: { children: nodes } }],
    [{ name: 'submit_branches', args: { children: nodes } }],
  ];
  globalThis.fetch = async () => sseMessage(script.shift());
  try {
    const result = await runPiAgent({ connection, job, skill, hub, emit: e => events.push(e) });
    assert.match(events.find(e => e.type === 'tool_end' && !e.ok).reason, /行动步骤/);
    assert.ok(events.some(e => e.type === 'tool_recovered' && e.tool === 'plan_work'));
    assert.equal(result.agent.toolFailures, 1); assert.equal(result.agent.recoveredFailures, 1); assert.equal(result.agent.unresolvedFailures, 0);
  } finally { globalThis.fetch = saved; }
});
test('a different successful webpage does not hide a failed webpage, and raw error details stay private', async () => {
  const saved = globalThis.fetch, events = [];
  const nodes = children.map(c => ({ ...c, sourceIds: [] }));
  const script = [first, [
    { name: 'read_public_page', args: { url: 'https://example.org/fails' } },
    { name: 'read_public_page', args: { url: 'https://example.org/works' } },
  ], [{ name: 'validate_branches', args: { children: nodes } }], [{ name: 'submit_branches', args: { children: nodes } }]];
  globalThis.fetch = async () => sseMessage(script.shift());
  try {
    const result = await runPiAgent({ connection, job, skill, hub, emit: e => events.push(e), pageReader: async url => {
      if (url.endsWith('/fails')) throw Error('fetch failed: private-debug-secret');
      return { url, title: '公开材料', text: '内容' };
    } });
    assert.equal(result.agent.recoveredFailures, 0); assert.equal(result.agent.unresolvedFailures, 1);
    assert.doesNotMatch(JSON.stringify(events), /private-debug-secret/);
    assert.match(events.find(e => e.type === 'tool_end' && !e.ok).reason, /外部服务/);
  } finally { globalThis.fetch = saved; }
});

test('project Agent lists the isolated catalogue, selects multiple methods and never exposes other SkillHub tools', async () => {
  const saved = globalThis.fetch, events = [], requests = [];
  const nodes = children.map(c => ({ ...c, sourceIds: [] }));
  const skills = [{ id: 'design', name: '游戏设计', description: '玩法与反馈', version: '1', content: '围绕玩法循环、反馈与玩家动机分析。' }, { id: 'research', name: '用户研究', description: '访谈', version: '1', content: '区分事实与假设，设计实验。' }, { id: 'disabled', name: '停用方法', enabled: false, content: 'must-not-leak' }];
  const script = [[first[0], first[1], { name: 'list_project_skills', args: {} }], [{ name: 'read_skill', args: { id: 'design' } }, { name: 'read_skill', args: { id: 'research' } }], [{ name: 'validate_branches', args: { children: nodes } }], [{ name: 'submit_branches', args: { children: nodes } }]];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body); requests.push(payload);
    assert.ok(payload.tools.some(t => t.function.name === 'list_project_skills'));
    assert.ok(!payload.tools.some(t => ['search_skillhub','inspect_skillhub','read_skillhub_files'].includes(t.function.name)));
    assert.doesNotMatch(options.body, /must-not-leak/);
    return sseMessage(script.shift());
  };
  try {
    const result = await runPiAgent({ connection, job: { ...job, project: { id: 'project1', name: '游戏项目' } }, skills, hub, emit: e => events.push(e) });
    assert.deepEqual(result.agent.selectedSkills.map(s => s.id), ['design','research']); assert.equal(result.agent.projectId, 'project1');
    assert.equal(events.filter(e => e.type === 'skill_selected').length, 2);
    assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.content.includes('用户研究')));
    assert.ok(requests[2].messages.some(m => m.role === 'tool' && m.content.includes('围绕玩法循环')));
  } finally { globalThis.fetch = saved; }
});
test('a foreign Skill ID cannot be read and cannot satisfy the project generation prerequisite', async () => {
  const saved = globalThis.fetch, events = [];
  const nodes = children.map(c => ({ ...c, sourceIds: [] }));
  const script = [[first[0], first[1], { name: 'list_project_skills', args: {} }], [{ name: 'read_skill', args: { id: 'foreign-project-skill' } }], [{ name: 'validate_branches', args: { children: nodes } }]];
  globalThis.fetch = async () => sseMessage(script.shift());
  try {
    await assert.rejects(runPiAgent({ connection, job, skill, skills: [{ ...skill, id: 'allowed' }], hub, emit: e => events.push(e), limits: { modelCalls: 3, toolCalls: 20, pages: 5, timeoutMs: 5000 } }), e => e.code === 'AGENT_LIMIT');
    assert.ok(events.some(e => e.type === 'tool_end' && e.tool === 'read_skill' && !e.ok));
    assert.ok(events.some(e => e.type === 'tool_end' && e.tool === 'validate_branches' && !e.ok));
    assert.equal(events.some(e => e.type === 'skill_selected'), false);
  } finally { globalThis.fetch = saved; }
});

test('a failed filesystem Skill read cannot satisfy the project prerequisite or appear as an adopted Skill', async () => {
  const saved = globalThis.fetch, events = [];
  const nodes = children.map(c => ({ ...c, sourceIds: [] }));
  const script = [[first[0], first[1], { name: 'list_project_skills', args: {} }], [{ name: 'read_skill', args: { id: 'allowed' } }], [{ name: 'validate_branches', args: { children: nodes } }]];
  globalThis.fetch = async () => sseMessage(script.shift());
  try {
    await assert.rejects(runPiAgent({ connection, job, skill, skills: [{ ...skill, id: 'allowed' }], skillLoader: async () => { throw Error('file missing'); }, hub, emit: e => events.push(e), limits: { modelCalls: 3, toolCalls: 20, pages: 5, timeoutMs: 5000 } }), e => e.code === 'AGENT_LIMIT');
    assert.equal(events.some(e => e.type === 'skill_selected'), false);
    assert.ok(events.some(e => e.type === 'tool_end' && e.tool === 'validate_branches' && !e.ok));
  } finally { globalThis.fetch = saved; }
});

test('twenty-round budget reserves the last four rounds and accepts omitted empty references', async () => {
  const { AGENT_LIMITS } = await import('../runtime/pi-agent.mjs');assert.equal(AGENT_LIMITS.modelCalls,20);
  const saved=globalThis.fetch,events=[],requests=[];let pages=0;
  const nodes=children.map(({sourceIds,...node})=>node);
  const script=[first,...Array.from({length:15},()=>[{name:'read_skill',args:{}}]),[{name:'read_public_page',args:{url:'https://garden.org/extra'}}],[{name:'validate_branches',args:{children:nodes}}],[{name:'submit_branches',args:{children:nodes}}]];
  globalThis.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return sseMessage(script.shift());};
  try{
    const result=await runPiAgent({connection,job,skill,hub,emit:e=>events.push(e),pageReader:async()=>{pages++;throw Error('Should stop exploring');}});
    assert.equal(result.agent.modelCalls,19);assert.equal(pages,0);
    assert.ok(events.some(e=>e.type==='finishing'&&e.remaining===4));
    assert.ok(requests[16].messages.some(m=>m.role==='user'&&m.content.includes('剩余 4 轮')));
    assert.equal(result.children.length,3);
  }finally{globalThis.fetch=saved;}
});
test('schema diagnostics name only known fields and never echo candidate contents', async () => {
  const { publicToolFailure }=await import('../runtime/pi-agent.mjs');
  const reason=publicToolFailure('validate_branches',{content:[{type:'text',text:'Validation failed for tool "validate_branches":\n - children[0].note: Expected string\n\nReceived arguments:\n{"private":"must-not-leak"}'}]});
  assert.match(reason,/children\[0\]\.note/);assert.doesNotMatch(reason,/must-not-leak|private/);
});

test('plan compatibility accepts action objects, long items and a single step without retrying the model',async()=>{
 const saved=globalThis.fetch;
 try{
  for(const steps of [[{title:'先理解整树',status:'pending'},{action:'选择领域方法',id:2},{description:'构造并校验分支'}],['行动说明'.repeat(90)],'读取全局\n选择方法\n校验并提交']){
   const nodes=children.map(c=>({...c,sourceIds:[]})),events=[];
   const script=[[{name:'plan_work',args:{steps}},...first.slice(1)],[{name:'validate_branches',args:{children:nodes}}],[{name:'submit_branches',args:{children:nodes}}]];
   globalThis.fetch=async()=>sseMessage(script.shift());const result=await runPiAgent({connection,job,skill,hub,emit:e=>events.push(e)});
   assert.equal(result.agent.modelCalls,3);assert.equal(result.agent.toolFailures,0);assert.ok(result.agent.plan.every(s=>typeof s==='string'&&s.length<=240));
  }
 }finally{globalThis.fetch=saved;}
});


test('node references are read through an ID-scoped tool and real images reach the next model request', async () => {
  const saved=globalThis.fetch,requests=[],reads=[];
  const reference={id:'image-one',type:'image',name:'场景参考',url:'https://images.example.org/scene.png',description:''};
  const scopedJob={...job,mapContext:{target:{id:'node',index:1,resources:[reference]},nodes:[{id:'node',resources:[reference]}],overview:{outline:[{id:'node'}],references:[reference]}}};
  const script=[first,[{name:'read_reference',args:{id:'foreign-resource'}},{name:'read_reference',args:{id:reference.id}}],[{name:'validate_branches',args:{children}}],[{name:'submit_branches',args:{children}}]];
  globalThis.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return sseMessage(script.shift());};
  try {
    const result=await runPiAgent({connection:{...connection,visionEnabled:true},job:scopedJob,skill,hub,referenceReader:async id=>{reads.push(id);return {title:reference.name,url:reference.url,description:'',image:{data:'aW1hZ2U=',mimeType:'image/png'}};}});
    assert.deepEqual(reads,['image-one']);assert.equal(result.agent.sources[0].id,'S1');
    assert.ok(JSON.stringify(requests[2].messages).includes('data:image/png;base64,aW1hZ2U='),'Pi converts tool image into a real image input for the provider');
    assert.ok(requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('资源未加入')));
  }finally{globalThis.fetch=saved;}
});
