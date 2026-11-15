import { PublicPageError } from '../runtime/public-page.mjs';
// Real E2B VMs and real Pi SDK, with controlled SSE model responses (no paid LLM request).
import { platformE2BKey } from '../runtime/platform-config.mjs';
import { buildMapContext } from '../runtime/map-context.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox, NotFoundError } from 'e2b';
import { createHash } from 'node:crypto';
import { runE2BAgent } from '../runtime/e2b-runner.mjs';
import { sseMessage } from '../tests/fixtures/pi-sse.mjs';
const key = platformE2BKey(process.env.E2B_API_KEY);
if (key && !key.startsWith('e2b_')) { console.error('E2B_API_KEY is set, but even after removing whitespace, quotes and assignment syntax it does not begin with e2b_. Verify the repository Secret name and its actual value.'); process.exit(1); }
if (!key) throw Error('Set platform E2B_API_KEY to run the live sandbox test.');
const taskIds = [];
async function task(marker) {
  const referenceId='reference-'+marker;
  const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  let sawReference=false,sawImage=false;
  const expectedOutputBudget = marker === 'isolated-alpha' ? 16384 : 8192;
  const directory = 'skills/method', file = Buffer.from('import os, json\ncontext=json.load(open("/workspace/task/map-context.json"))\nassert context["totalNodes"]==2 and context["target"]["id"]=="root"\nassert not os.environ.get("E2B_API_KEY")\nassert not os.path.exists("/var/lib/mind/projects.sqlite")\nprint("' + marker + '")\n');
  const children = ['边界是什么？','风险如何验证？','方案如何验收？'].map(title => ({ title, note:'【决策意义】明确当前项目任务的约束和判断标准，避免在资料不足时采用未经验证的假设。【验证方式】使用本项目的方法与脚本开展可重复的小范围检查，根据执行结果确认需要调整的条件。', sourceIds:[] }));
  const script = [
    [{name:'plan_work',args:{steps:['读取项目目录与方法','执行本地验证并校验分支']}},{name:'read_node_context',args:{}},{name:'list_project_skills',args:{}}],
    [{name:'read_skill',args:{id:'method'}}],
    [{name:'read_public_page',args:{url:'https://example.org/blocked'}},{name:'read_reference',args:{id:referenceId}}],
    [{name:'run_command',args:{command:'python3 ' + directory + '/scripts/check.py'}}],
    [{name:'validate_branches',args:{children}}],
    [{name:'submit_branches',args:{children}}],
  ];
  let sawCommandOutput = false;
  const events = [];
  const result = await runE2BAgent({ apiKey:key, template:process.env.E2B_TEMPLATE_ID || '', runtimeArchive:resolve(process.env.SANDBOX_RUNTIME_ARCHIVE || (existsSync('.release/stage/sandbox-runtime.tar.gz') ? '.release/stage/sandbox-runtime.tar.gz' : 'sandbox-runtime.tar.gz')), connection:{url:'https://api.vendor.com/v1/chat/completions',model:'tool-capable-model',key:'not-a-paid-key',maxOutputTokens:expectedOutputBudget,visionEnabled:true},
    job:{mapContext:buildMapContext({workspace:{maps:[{id:'map',title:'全局上下文',root:{id:'root',title:'目标主题',resources:[{id:referenceId,name:marker+'图片',type:'image',url:'https://example.org/image.png',description:marker}],children:[{id:'other',title:'另一个分支的约束',note:'全局规则',children:[]}]}}]}},'map','root'),project:{id:'smoke-'+marker,name:marker},topic:'任务隔离验证',title:'隔离边界',brief:'控制响应验证',note:'',instruction:'',ancestors:[],ancestorContext:[],existing:[],mode:'questions',quantity:3},
    skills:[{id:'method',name:'隔离验证方法',version:'1',description:'执行本地检查',content:'# 隔离验证\n读取 scripts/check.py 并执行，不能编造验证结果。',directory,files:[{path:'SKILL.md',base64:Buffer.from('# 隔离验证\n执行本地检查').toString('base64'),sha256:createHash('sha256').update('# 隔离验证\n执行本地检查').digest('hex')},{path:'scripts/check.py',base64:file.toString('base64'),sha256:createHash('sha256').update(file).digest('hex')}]}],
    sandboxFactory:async options=>{try{return await Sandbox.create(options);}catch(error){
      const message=String(error.message || '').split(key).join('[redacted]').replace(/e2b_[a-zA-Z0-9_-]+/g,'[redacted]');
      console.error('E2B create diagnostic: '+error.name+' — '+message.slice(0,600));throw error;
    }},
    emit:event=>{events.push(event);if(event.type==='sandbox_created')taskIds.push(event.taskId);console.log(marker + ': ' + event.type + (event.tool ? ' '+event.tool : '') + (event.reason ? ' '+event.reason : ''));},
    pageReader:async()=>{throw new PublicPageError('PAGE_HTTP','网页返回 HTTP 403');},
    referenceReader:async(id)=>{assert.equal(id,referenceId);sawReference=true;return {title:marker+'图片',url:'https://example.org/image.png',description:marker,image:{data:image,mimeType:'image/png'}};},
    modelProxy:async(connection,raw,signal,onStream)=>{const body=JSON.parse(raw);assert.equal(body.max_tokens,expectedOutputBudget);if(JSON.stringify(body.messages).includes('data:image/png;base64,'+image))sawImage=true;if(body.messages.some(m=>{if(m.role!=='tool')return false;try{return JSON.parse(m.content).output?.trim()===marker;}catch{return false;}}))sawCommandOutput=true;const calls=script.shift();assert.ok(calls,'Unexpected model request');const response=sseMessage(calls);const bytes=Buffer.from(await response.text());await onStream({type:'start',status:200,contentType:'text/event-stream'});for(let offset=0;offset<bytes.length;offset+=512)await onStream({type:'chunk',data:bytes.subarray(offset,offset+512)});return {status:200,contentType:'text/event-stream',streamed:true};},
  });
  assert.equal(result.children.length,3);assert.equal(result.agent.sandbox.provider,'e2b');assert.equal(result.agent.selectedSkills[0].id,'method');
  assert.ok(events.some(e=>e.type==='tool_end'&&e.tool==='read_public_page'&&!e.ok&&/403/.test(e.reason)),'Safe webpage HTTP cause must cross the real sandbox bridge');
  assert.equal(sawReference,true);assert.equal(sawImage,true,'Reference image must reach the real Pi model request');
  assert.equal(sawCommandOutput,true,'Real script output must reach the next Pi model turn');
  assert.ok(events.some(e=>e.type==='tool_end'&&e.tool==='run_command'&&e.ok));
  assert.ok(events.some(e=>e.type==='sandbox_destroyed'));
  assert.ok(events.some(e=>e.type==='model_stream'));
  assert.ok(events.some(e=>e.type==='map_context'&&e.totalNodes===2));
  assert.ok(events.some(e=>e.type==='started'&&e.limits.modelCalls===20));
  return result.agent.sandbox.taskId;
}
try {
  const ids = await Promise.all([task('isolated-alpha'),task('isolated-beta')]);
  assert.notEqual(ids[0],ids[1]);
  for(const id of ids){
    try { await Sandbox.getInfo(id,{apiKey:key,requestTimeoutMs:10000}); throw Error('Sandbox remains after completion'); }
    catch(error){if(!(error instanceof NotFoundError))throw error;}
  }
  console.log('Verified two distinct E2B VMs, prepared Skill scripts, real Pi tool loop, command output isolation and destruction. No paid LLM request.');
} catch(error) {
  console.error('E2B smoke failed: '+(error.code || error.name)+' — '+(error.code?.startsWith('AGENT') ? error.message : 'see the last lifecycle stage above'));
  process.exitCode=1;
} finally {
  await Promise.all(taskIds.map(id=>Sandbox.kill(id,{apiKey:key,requestTimeoutMs:10000}).catch(()=>{})));
}
