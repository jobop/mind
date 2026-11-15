import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSkillSnapshot } from '../runtime/skill-snapshot.mjs';
import { runE2BAgent } from '../runtime/e2b-runner.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
test('task preparation pins full Skill files, isolates project caches, and keeps project edits authoritative', async () => {
  const directory = await mkdtemp(join(tmpdir(),'mind-snapshot-')); let downloads = 0;
  const script = Buffer.from('print("skill script")');
  const loadBundle = async origin => { downloads++; assert.equal(origin.version,'1.2.0'); return { files: [{ path:'scripts/check.py', base64:script.toString('base64'), sha256:hash(script) }] }; };
  const skills = [{ id:'one',name:'方法',content:'项目编辑后的正文',version:'1.2.0',origin:{provider:'skillhub',slug:'sample',version:'1.2.0'} }];
  try {
    const a = await prepareSkillSnapshot({skills,projectId:'project-a',cacheDirectory:directory,loadBundle});
    assert.equal(a[0].files.length,2);
    assert.equal(Buffer.from(a[0].files.find(f=>f.path==='SKILL.md').base64,'base64').toString(), '项目编辑后的正文');
    await prepareSkillSnapshot({skills,projectId:'project-a',cacheDirectory:directory,loadBundle}); assert.equal(downloads,1);
    await prepareSkillSnapshot({skills,projectId:'project-b',cacheDirectory:directory,loadBundle}); assert.equal(downloads,2);
    assert.equal((await readdir(directory)).length,2);
    await assert.rejects(prepareSkillSnapshot({skills,projectId:'bad',cacheDirectory:directory,loadBundle:async()=>({files:[{path:'x',base64:'YWJj',sha256:'0'.repeat(64)}]})}), /完整性/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
function mockSandbox(mode = 'success') {
  const state={kills:0,writes:[],options:null,commands:[],input:null}; let finish, callbacks;
  const wait=new Promise(resolve=>finish=resolve);
  const factory=async options=>{
    state.options=options;
    const handle={wait:()=>wait,sendStdin:async line=>{
      const message=JSON.parse(line);
      if(message.type==='start') {
        callbacks.onStdout(JSON.stringify({type:'sandbox_ready',count:1})+'\n');
        if(mode==='failure') { callbacks.onStdout(JSON.stringify({type:'error'})+'\n'); finish(); }
        else if(mode==='success') callbacks.onStdout(JSON.stringify({type:'rpc',id:1,operation:'model',payload:{body:'{"messages":[],"tools":[]}'}})+'\n');
      } else if(message.type==='rpc_result') {
        callbacks.onStdout(JSON.stringify({type:'result',result:{children:[],agent:{framework:'pi-agent-core'}}})+'\n');finish();
      }
    }};
    return {sandboxId:'sandbox-'+Math.random(),files:{write:async(path,data)=>{state.writes.push(path);if(path.endsWith('input.json'))state.input=JSON.parse(data);}},commands:{run:async(command,options)=>{state.commands.push({command,options});if(options.background){callbacks=options;return handle;}return {exitCode:0};}},kill:async()=>{state.kills++;finish();return true;}};
  };
  return {state,factory};
}
test('E2B lifecycle starts a fresh isolated VM, brokers model traffic without real credentials, and destroys it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mind-e2b-')),archive=join(directory,'runtime.tar.gz');await writeFile(archive,'test archive');
  const mock=mockSandbox(),events=[];
  try {
    const result=await runE2BAgent({apiKey:'platform-e2b-secret',runtimeArchive:archive,connection:{url:'https://api.vendor.com/v1/chat/completions',model:'model',key:'real-model-secret'},job:{project:{id:'p1',name:'项目'}},skills:[{id:'one',name:'方法',content:'正文',files:[]}],sandboxFactory:mock.factory,emit:e=>events.push(e),modelProxy:async connection=>{assert.equal(connection.key,'real-model-secret');return {status:200,contentType:'text/event-stream',body:'data: [DONE]\n\n'};}});
    assert.equal(mock.state.options.allowInternetAccess,false);assert.equal(mock.state.options.network.allowPublicTraffic,false);assert.equal(mock.state.options.timeoutMs,300000);
    assert.equal(mock.state.options.envs,undefined);assert.equal(mock.state.input.connection.key,'brokered-no-real-key');
    assert.doesNotMatch(JSON.stringify(mock.state.input),/platform-e2b-secret|real-model-secret/);
    assert.equal(mock.state.kills,1);assert.equal(result.agent.sandbox.provider,'e2b');
    assert.equal(events.at(-1).type,'sandbox_destroyed');
    assert.match(mock.state.commands[1].command,/sandbox-task.mjs/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('task failure, cancellation and runtime-upload failure all trigger sandbox cleanup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mind-e2b-cleanup-')),archive=join(directory,'runtime.tar.gz');await writeFile(archive,'test archive');
  try{
    for(const mode of ['failure','cancel','missing-runtime']){
      const mock=mockSandbox(mode),controller=new AbortController();
      const run=runE2BAgent({apiKey:'platform',runtimeArchive:mode==='missing-runtime'?join(directory,'missing'):archive,connection:{url:'https://api.vendor.com/v1/chat/completions',model:'m',key:'secret'},job:{project:{id:'p'}},skills:[{}],sandboxFactory:mock.factory,signal:controller.signal,emit:event=>{if(mode==='cancel'&&event.type==='sandbox_ready')controller.abort();}});
      await assert.rejects(run,error=>error.code===(mode==='cancel'?'CANCELLED':'AGENT_SANDBOX_FAILED'));
      assert.ok(mock.state.kills>=1,mode);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('platform E2B credentials accept copy formatting without disclosing their value', async () => {
  const { platformE2BKey } = await import('../runtime/platform-config.mjs');
  for (const input of [' e2b_test \n', 'E2B_API_KEY=e2b_test', 'export E2B_API_KEY="e2b_test"', "'e2b_test'"]) assert.equal(platformE2BKey(input), 'e2b_test');
});
