import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const skillsSource = await readFile(new URL('../web/skills.js', import.meta.url), 'utf8');
const hubSource = await readFile(new URL('../web/skillhub.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.style = {}; this.dataset = {}; this.value = ''; this.children = []; this.open = false; this.classList = { add() {}, remove() {}, toggle() {} }; this.clientWidth = 900; this.clientHeight = 600; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  addEventListener() {}
  closest() { return new Element(); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  getBoundingClientRect() { return { left: 20, top: 20, width: 210, height: 360 }; }
  querySelector() { return this.children.find(c => c.onclick && !c.disabled) || null; }
  querySelectorAll() { return this.children.filter(c => c.onclick && !c.disabled); }
  contains(el) { return el === this || this.children.includes(el); }
  click() { return this.onclick?.({ target: this, stopPropagation() {} }); }
}
function app(initial) {
  const elements = new Map(), store = new Map(initial ? [['branch-ai-workspace-v1', JSON.stringify(initial)]] : []);
  const storage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: () => new Element(), createElementNS: () => new Element(), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const context = vm.createContext({ document, window: { innerWidth: 1280, innerHeight: 800, addEventListener() {} }, crypto: webcrypto, localStorage: storage, sessionStorage: storage, ResizeObserver: class { observe() {} }, requestAnimationFrame: fn => fn(), setTimeout: () => 0, clearTimeout() {}, URL, Blob, TextDecoder, AbortController, console, fetch: async () => Response.json({ configured: false }) });
  vm.runInContext(skillsSource, context);
  vm.runInContext(source, context);
  vm.runInContext(hubSource, context);
  const run = code => vm.runInContext(code, context);
  run("$('branchCount').value='3'");
  return { run, store, context };
}
test('preserves existing saved maps and starts new workspaces with a blank topic', () => {
  const original = { maps: [{ id: 'map1', title: '原有导图', root: { id: 'root1', title: '已有主题', note: '重要笔记', children: [] } }], active: 'map1' };
  const { run } = app(original);
  assert.equal(run('map().root.note'), '重要笔记');
  assert.equal(run('map().id'), 'map1');
  const blank = app();
  assert.equal(blank.run('count(map().root)'), 1);
  assert.equal(blank.run('validWorkspace(workspace)'), true);
});
test('does not generate placeholders when disconnected; failed generation preserves the tree', async () => {
  const { run } = app();
  await run('generate()');
  assert.equal(run('count(map().root)'), 1);
  assert.equal(run("$('settingsDialog').open"), true);
  run("connection={configured:true,model:'live-model'};fetch=async()=>{throw Error('service down')}");
  await run('generate()');
  assert.equal(run('count(map().root)'), 1);
  assert.equal(run('failedRequest.error'), 'service down');
});
test('applies real responses to the captured target, supports retry, undo and redo', async () => {
  const { run } = app();
  run("connection={configured:true,model:'live-model'};fetch=async()=>{throw Error('retry me')}");
  await run('generate()');
  run("fetch=async()=>({ok:true,json:async()=>({children:[{title:'问题甲',note:'详情甲'},{title:'问题乙',note:'详情乙'},{title:'问题丙',note:'详情丙'}],model:'live-model',generatedAt:'2026-11-15T05:00:00Z'})})");
  await run('generate(failedRequest)');
  assert.equal(run('count(map().root)'), 4);
  assert.equal(run('map().root.children[0].generated.model'), 'live-model');
  assert.equal(run('failedRequest'), null);
  run("$('undoBtn').onclick()"); assert.equal(run('count(map().root)'), 1);
  run("$('redoBtn').onclick()"); assert.equal(run('count(map().root)'), 4);
  assert.equal(run('validWorkspace(JSON.parse(localStorage.getItem(KEY)))'), true);
});
test('cancel does not commit late results', async () => {
  const { run } = app();
  run("connection={configured:true,model:'live-model'};let resolveRequest;fetch=()=>new Promise(resolve=>resolveRequest=resolve)");
  const pending = run('generate()');
  run("$('cancelGenerate').onclick();resolveRequest({ok:true,json:async()=>({children:[{title:'a',note:''},{title:'b',note:''},{title:'c',note:''}],model:'live-model',generatedAt:'2026-11-15T05:00:00Z'})})");
  await pending;
  assert.equal(run('count(map().root)'), 1);
  assert.equal(run('busy'), false);
});
test('map deletion is undoable; JSON validation rejects excessive depth and duplicate IDs', () => {
  const { run } = app();
  run("const oldId=map().id;$('confirmDeleteMap').onclick()");
  assert.equal(run('map().id===oldId'), false);
  run("$('undoBtn').onclick()"); assert.equal(run('map().id===oldId'), true);
  assert.equal(run("validTree({id:'a',title:'a',children:[{id:'a',title:'b',children:[]}]})"), false);
  assert.equal(run("validTree({id:'a',title:'a',note:'x'.repeat(3001),children:[]})"), false);
});
test('per-map Skill and project context survive save, snapshots and undo', () => {
  const { run } = app();
  run("$('skillSelect').onchange({target:{value:'engineering'}})");
  assert.equal(run('map().skill.id'), 'engineering');
  run("openSkillSettings();$('projectBrief').value='单机部署，预算有限';$('skillForm').onsubmit({preventDefault(){}})");
  assert.equal(run('requestSnapshot().payload.skill.id'), 'engineering');
  assert.equal(run('requestSnapshot().payload.brief'), '单机部署，预算有限');
  assert.equal(run('JSON.parse(localStorage.getItem(KEY)).maps[0].skill.id'), 'engineering');
  run("$('undoBtn').onclick()");
  assert.equal(run("map().brief || ''"), '');
  assert.equal(run('map().skill.id'), 'engineering');
});
test('Markdown Skill supports frontmatter, preserves plain text and validates bounds', () => {
  const { run } = app();
  const skill = run("parseSkillMarkdown('---\\nname: \"领域专家\"\\n---\\n\\n# 分析步骤\\n按风险与验证证据拆解。','SKILL.md')");
  assert.equal(skill.name, '领域专家');
  assert.equal(skill.content, '# 分析步骤\n按风险与验证证据拆解。');
  assert.equal(run("parseSkillMarkdown('# 增长分析\\n先定位留存瓶颈。','SKILL.md').name"), '增长分析');
  assert.equal(run("validSkill({id:'custom',name:'规则',content:'<script>alert(1)</script>'})"), true);
  assert.throws(() => run("parseSkillMarkdown('x'.repeat(12001),'big.md')"));
  assert.equal(run("validSkill({id:'custom',name:'规则',content:''})"), false);
  assert.equal(run("validMapSettings({skill:{id:'unknown'}})"), false);
});
test('right-click selects the exact node and invokes the correct generation direction', () => {
  const { run } = app();
  run("map().root.children.push({id:'child',title:'成本结构',note:'按用户核算',children:[]});render();let captured;generate=()=>{captured=requestSnapshot()}");
  run("openContextMenu({clientX:1275,clientY:795,preventDefault(){},stopPropagation(){}},'child')");
  assert.equal(run('selected'), 'child');
  assert.equal(run("$('contextMenu').hidden"), false);
  assert.equal(run("$('contextMenu').style.left"), '1062px');
  assert.equal(run("$('contextMenu').style.top"), '432px');
  run("$('contextMenu').children.find(b=>b.textContent==='◇ 生成解决方案').onclick()");
  assert.equal(run('captured.nodeId'), 'child');
  assert.equal(run('captured.payload.mode'), 'solutions');
  assert.equal(run('captured.payload.title'), '成本结构');
  assert.equal(run("$('contextMenu').hidden"), true);
  run("openContextMenu({clientX:0,clientY:0,preventDefault(){},stopPropagation(){}},map().root.id)");
  assert.equal(run("$('contextMenu').children.find(b=>b.textContent==='⌫ 删除节点及分支').disabled"), true);
});
test('JSON import restores custom methodology, context and generation provenance', async () => {
  const { run } = app();
  run("const backup={format:'branch-ai',version:1,map:{title:'导入测试',brief:'已知事实',skill:{id:'custom',name:'行业标准',content:'先识别约束，再设计实验'},root:{id:'r',title:'项目',note:'',children:[{id:'c',title:'问题',note:'证据',children:[],generated:{model:'model',at:'2026-11-15T05:00:00Z',skill:{id:'custom',name:'行业标准',version:'custom'}}}]}}};let input={target:{files:[{size:1000,text:async()=>JSON.stringify(backup)}]}};");
  await run("$('importFile').onchange(input)");
  assert.equal(run('map().skill.name'), '行业标准');
  assert.equal(run('map().brief'), '已知事实');
  assert.equal(run('map().root.children[0].generated.skill.name'), '行业标准');
  assert.equal(run('validWorkspace(workspace)'), true);
});
test('SkillHub text preview becomes an editable per-map Skill with a pinned source', () => {
  const { run } = app();
  run("openSkillSettings();hubSelection={name:'用户研究',slug:'user-research',version:'1.0.0'};hubDocuments={slug:'user-research',version:'1.0.0',documents:[{path:'SKILL.md',content:'---\\nname: research\\n---\\n# 用户任务\\n先识别真实场景。',sha256:'a'.repeat(64)},{path:'references/method.md',content:'用近期行为访谈交叉验证。',sha256:'b'.repeat(64)}]};useHubSkill()");
  assert.match(run("$('skillContent').value"), /先识别真实场景/);
  assert.match(run("$('skillContent').value"), /参考文档：references\/method.md/);
  assert.doesNotMatch(run("$('skillContent').value"), /name: research/);
  run("$('skillForm').onsubmit({preventDefault(){}})");
  assert.equal(run('map().skill.origin.slug'), 'user-research');
  assert.equal(run('map().skill.origin.version'), '1.0.0');
  assert.equal(run('map().skill.origin.files.length'), 2);
  assert.equal(run('requestSnapshot().payload.skill.origin.slug'), 'user-research');
  run("openSkillSettings();$('skillContent').value+='\\n修订';markCustomSkill();$('skillForm').onsubmit({preventDefault(){}})");
  assert.equal(run('map().skill.origin.modified'), true);
});
test('streamed Pi progress is shown and only the final result updates the graph', async () => {
  const { run, context } = app();
  const result = { children: ['甲','乙','丙'].map(t => ({ title: '问题'+t, note: '具体说明' })), model: 'agent-model', generatedAt: '2026-11-15T05:00:00Z', skill: { id: 'general', name: '结构化分析' }, agent: { framework: 'pi-agent-core', version: '1.5.2', runId: 'run-1', modelCalls: 4, toolCalls: 7, usage: { input: 100 }, plan: ['读取材料','核验'], sources: [{ id: 'S1', title: '材料', url: 'https://garden.org/info' }] } };
  const events = [{ type: 'connected' }, { type: 'started', limits: { modelCalls: 8 } }, { type: 'plan', steps: ['读取材料','核验'] }, { type: 'tool_start', label: '读取领域 Skill' }, { type: 'validation', valid: true }, { type: 'result', result }];
  const bytes = new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n');
  context.agentStreamResponse = new Response(new ReadableStream({ start(controller) { for(let i=0;i<bytes.length;i+=17) controller.enqueue(bytes.slice(i,i+17)); controller.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  run("connection={configured:true,model:'agent-model'};fetch=async()=>agentStreamResponse");
  await run('generate()');
  assert.equal(run('count(map().root)'), 4);
  assert.equal(run('map().root.children[0].generated.agent.framework'), 'pi-agent-core');
  assert.equal(run('map().agentRuns[0].runId'), 'run-1');
  assert.ok(run("$('agentTrace').children.length") >= 4);
  assert.equal(run("$('agentSources').children.length"), 1);
  run("const originalMapId=map().id;const otherMap=newMap('其他主题');workspace.maps.push(otherMap);switchMap(otherMap.id)");
  assert.equal(run("$('agentPanel').hidden"), true);
  run('switchMap(originalMapId)');
  assert.equal(run("$('agentPanel').hidden"), false);
  assert.equal(run("$('agentSources').children.length"), 1);
});
test('broken Agent stream preserves original nodes and surfaces the failure', async () => {
  const { run, context } = app();
  context.agentStreamResponse = new Response('{"type":"error","error":"工具执行失败","code":"AGENT_ERROR"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  run("connection={configured:true,model:'agent-model'};fetch=async()=>agentStreamResponse");
  await run('generate()');
  assert.equal(run('count(map().root)'), 1); assert.equal(run('failedRequest.error'), '工具执行失败');
});
