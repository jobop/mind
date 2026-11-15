// Real E2B VMs and real Pi SDK, with controlled SSE model responses (no paid LLM request).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox, NotFoundError } from 'e2b';
import { createHash } from 'node:crypto';
import { runE2BAgent } from '../runtime/e2b-runner.mjs';
import { sseMessage } from '../tests/fixtures/pi-sse.mjs';
const key = process.env.E2B_API_KEY;
if (!key) throw Error('Set platform E2B_API_KEY to run the live sandbox test.');
const taskIds = [];
async function task(marker) {
  const directory = 'skills/method', file = Buffer.from('import os\nassert not os.environ.get("E2B_API_KEY")\nassert not os.path.exists("/var/lib/mind/projects.sqlite")\nprint("' + marker + '")\n');
  const children = ['边界是什么？','风险如何验证？','方案如何验收？'].map(title => ({ title, note:'【决策意义】明确当前项目任务的约束和判断标准，避免在资料不足时采用未经验证的假设。【验证方式】使用本项目的方法与脚本开展可重复的小范围检查，根据执行结果确认需要调整的条件。', sourceIds:[] }));
  const script = [
    [{name:'plan_work',args:{steps:['读取项目目录与方法','执行本地验证并校验分支']}},{name:'read_node_context',args:{}},{name:'list_project_skills',args:{}}],
    [{name:'read_skill',args:{id:'method'}}],
    [{name:'run_command',args:{command:'python3 ' + directory + '/scripts/check.py'}}],
    [{name:'validate_branches',args:{children}}],
    [{name:'submit_branches',args:{children}}],
  ];
  let sawCommandOutput = false;
  const events = [];
  const result = await runE2BAgent({ apiKey:key, template:process.env.E2B_TEMPLATE_ID || '', runtimeArchive:resolve(process.env.SANDBOX_RUNTIME_ARCHIVE || (existsSync('.release/stage/sandbox-runtime.tar.gz') ? '.release/stage/sandbox-runtime.tar.gz' : 'sandbox-runtime.tar.gz')), connection:{url:'https://api.vendor.com/v1/chat/completions',model:'tool-capable-model',key:'not-a-paid-key'},
    job:{project:{id:'smoke-'+marker,name:marker},topic:'任务隔离验证',title:'隔离边界',brief:'控制响应验证',note:'',instruction:'',ancestors:[],ancestorContext:[],existing:[],mode:'questions',quantity:3},
    skills:[{id:'method',name:'隔离验证方法',version:'1',description:'执行本地检查',content:'# 隔离验证\n读取 scripts/check.py 并执行，不能编造验证结果。',directory,files:[{path:'SKILL.md',base64:Buffer.from('# 隔离验证\n执行本地检查').toString('base64'),sha256:createHash('sha256').update('# 隔离验证\n执行本地检查').digest('hex')},{path:'scripts/check.py',base64:file.toString('base64'),sha256:createHash('sha256').update(file).digest('hex')}]}],
    sandboxFactory:async options=>{try{return await Sandbox.create(options);}catch(error){
      const message=String(error.message || '').split(key).join('[redacted]').replace(/e2b_[a-zA-Z0-9_-]+/g,'[redacted]');
      console.error('E2B create diagnostic: '+error.name+' — '+message.slice(0,600));throw error;
    }},
    emit:event=>{events.push(event);if(event.type==='sandbox_created')taskIds.push(event.taskId);console.log(marker + ': ' + event.type + (event.tool ? ' '+event.tool : '') + (event.reason ? ' '+event.reason : ''));},
    modelProxy:async(connection,raw)=>{const body=JSON.parse(raw);if(body.messages.some(m=>m.role==='tool'&&m.content.includes(marker)))sawCommandOutput=true;const calls=script.shift();assert.ok(calls,'Unexpected model request');const response=sseMessage(calls);return {status:200,contentType:'text/event-stream',body:await response.text()};},
  });
  assert.equal(result.children.length,3);assert.equal(result.agent.sandbox.provider,'e2b');assert.equal(result.agent.selectedSkills[0].id,'method');
  assert.equal(sawCommandOutput,true,'Real script output must reach the next Pi model turn');
  assert.ok(events.some(e=>e.type==='tool_end'&&e.tool==='run_command'&&e.ok));
  assert.ok(events.some(e=>e.type==='sandbox_destroyed'));
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
