import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../runtime/projects.mjs';
import { GenerationJobs } from '../runtime/generation-jobs.mjs';
import worker from '../dist/server/index.js';
const origin='https://mind.testing.com';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(){
  const projects=new ProjectService(':memory:'),jobs=new GenerationJobs(projects);
  const auth=await projects.handle(new Request(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'X-Branch-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'job-owner',password:'test-password-2026'})}));
  const cookie=auth.headers.get('Set-Cookie').split(';')[0];
  const req=(path,body,extra={})=>new Request(origin+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'X-Branch-Request':'1','Content-Type':'application/json',...extra},body:body?JSON.stringify(body):undefined});
  const p={name:'任务项目',brief:'背景',skills:[{id:'general',name:'方法',content:'方法正文',version:'1'}],workspace:{maps:[{id:'map',title:'主题',root:{id:'root',title:'主题',children:[]}}],active:'map'}};
  const created=await projects.handle(req('/api/projects',p)),project=await created.json();
  const input={clientRequestId:randomUUID(),projectId:project.id,mapId:'map',nodeId:'root',topic:'主题',title:'主题',mode:'questions',quantity:3,existing:[],ancestors:[]};
  const result={children:['问题一','问题二','问题三'].map(title=>({title,note:'【决策意义】这一因素会改变项目边界与设计取舍，需要区分已知事实和待验证假设。【验证方式】先用小范围实验收集证据，再根据实际结果确认或调整假设。'})),model:'model',generatedAt:new Date().toISOString(),agent:{framework:'pi-agent-core',runId:randomUUID(),modelCalls:3,toolCalls:6,sources:[]}};
  return {projects,jobs,req,input,result,project};
}
async function waitTerminal(jobs,req,id){for(let i=0;i<50;i++){const r=await(await jobs.handle(req('/api/generation-jobs/'+id))).json();if(['succeeded','failed','cancelled'].includes(r.status))return r;await tick();}throw Error('Task did not finish');}
test('background generation survives a disconnected caller, commits once and supports duplicate delivery',async()=>{
  const s=await setup();let release,calls=0;
  try{
    const controller=new AbortController();
    const request=new Request(s.req('/api/generate',s.input),{signal:controller.signal});
    const execute=async(emit,signal)=>{calls++;assert.notEqual(signal,request.signal);emit({type:'model_request',call:1,max:20});await new Promise(resolve=>release=resolve);assert.equal(signal.aborted,false);return s.result;};
    const accepted=s.jobs.start(request,{...s.input,key:'must-not-persist'},execute),meta=await accepted.json();
    await tick();controller.abort();
    const duplicate=await s.jobs.start(s.req('/api/generate',s.input),s.input,execute).json();assert.equal(duplicate.id,meta.id);assert.equal(calls,1);
    assert.doesNotMatch(s.jobs.db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(meta.id).input_json,/must-not-persist/);
    release();const done=await waitTerminal(s.jobs,s.req,meta.id);assert.equal(done.status,'succeeded');
    const saved=s.projects.get(s.req('/'),s.project.id);assert.equal(saved.workspace.maps[0].root.children.length,3);assert.equal(saved.revision,2);
    const repeat=await s.jobs.start(s.req('/api/generate',s.input),s.input,execute).json();assert.equal(repeat.status,'succeeded');assert.equal(calls,1);
    assert.equal(s.projects.get(s.req('/'),s.project.id).workspace.maps[0].root.children.length,3);
    assert.equal((await s.jobs.handle(new Request(origin+'/api/generation-jobs/'+meta.id))).status,401);
  }finally{s.projects.close();}
});
test('jobs enforce ownership and cancellation before start prevents resource creation',async()=>{
  const s=await setup();let calls=0;
  try{
    const cancelled=await s.jobs.handle(s.req('/api/generation-jobs/by-request/'+s.input.clientRequestId+'/cancel',{}));assert.equal(cancelled.status,200);
    assert.throws(()=>s.jobs.start(s.req('/api/generate',s.input),s.input,async()=>{calls++;return s.result;}),e=>e.code==='CANCELLED');assert.equal(calls,0);
    const input={...s.input,clientRequestId:randomUUID()};const meta=await s.jobs.start(s.req('/api/generate',input),input,async()=>s.result).json();await waitTerminal(s.jobs,s.req,meta.id);
    const other=await s.projects.handle(new Request(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'X-Branch-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'other-owner',password:'test-password-2026'})}));
    const cookie=other.headers.get('Set-Cookie').split(';')[0];
    const denied=await s.jobs.handle(new Request(origin+'/api/generation-jobs/'+meta.id,{headers:{Cookie:cookie}}));assert.equal(denied.status,404);
  }finally{s.projects.close();}
});
test('model failure stays in the task history and a late result cannot resurrect a deleted node',async()=>{
  const s=await setup();
  try{
    let meta=await s.jobs.start(s.req('/api/generate',s.input),s.input,async emit=>{emit({type:'model_request',call:1,max:20});throw Object.assign(Error('模型工具参数不正确'),{code:'AGENT_INCOMPLETE'});}).json();
    const failed=await waitTerminal(s.jobs,s.req,meta.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'AGENT_INCOMPLETE');assert.equal(failed.events.length,2);
    assert.equal(s.projects.get(s.req('/'),s.project.id).revision,1);
    let release;const input={...s.input,clientRequestId:randomUUID()};
    meta=await s.jobs.start(s.req('/api/generate',input),input,async()=>{await new Promise(resolve=>release=resolve);return s.result;}).json();await tick();
    s.projects.db.prepare('DELETE FROM projects WHERE id=?').run(s.project.id);release();
    assert.equal((await waitTerminal(s.jobs,s.req,meta.id)).status,'failed');
    assert.equal(s.projects.db.prepare('SELECT count(*) AS n FROM projects').get().n,0);
  }finally{s.projects.close();}
});
test('authenticated HTTP generation returns immediately and stores completed nodes without a connected browser',async()=>{
  const s=await setup();let release;
  const env={PROJECT_SERVICE:s.projects,GENERATION_JOBS:s.jobs,CONNECTION_ENCRYPTION_KEY:'test-encryption-key-over-thirty-two-characters',AGENT_TEST:async()=>{},AGENT_RUNNER:async()=>{await new Promise(resolve=>release=resolve);return s.result;}};
  try{
    const connect=await worker.fetch(s.req('/api/connection',{base:'https://api.vendor.com/v1',model:'model',key:'test-not-real-key'}),env);assert.equal(connect.status,200);
    const cookie=s.req('/').headers.get('Cookie')+'; '+connect.headers.get('Set-Cookie').split(';')[0];
    const accepted=await worker.fetch(s.req('/api/generate',s.input,{Cookie:cookie}),env);assert.equal(accepted.status,202);const task=await accepted.json();
    await tick();assert.equal(typeof release,'function');release();
    const done=await waitTerminal(s.jobs,s.req,task.id);assert.equal(done.status,'succeeded');
    assert.equal(s.projects.get(s.req('/'),s.project.id).workspace.maps[0].root.children.length,3);
  }finally{s.projects.close();}
});
