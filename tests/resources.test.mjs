import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectService,validateProject} from '../runtime/projects.mjs';
import {ResourceService,repositoryRequest,fetchReference} from '../runtime/resources.mjs';
import {buildMapContext} from '../runtime/map-context.mjs';
const origin='https://mind.example.org';
const project=name=>({name,brief:'',skills:[],workspace:{maps:[{id:'map',title:name,root:{id:'root',title:name,note:'',children:[]}}],active:'map'}});
async function account(p,name){const r=await p.handle(new Request(origin+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Branch-Request':'1'},body:JSON.stringify({username:name,password:'resource-test-password'})}));assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
const req=(path,cookie,body,method=body===undefined?'GET':'POST',extra={})=>new Request(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'X-Branch-Request':'1','Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
async function setup(options){const p=new ProjectService(':memory:'),s=new ResourceService(p,'durable-test-only-secret',options),alice=await account(p,'alice'),bob=await account(p,'bob');const a=await(await p.handle(req('/api/projects',alice,project('alpha')))).json(),b=await(await p.handle(req('/api/projects',alice,project('beta')))).json();return {p,s,alice,bob,a,b,path:'/api/projects/'+a.id+'/resources'};}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('Git credentials are encrypted, absent from node snapshots, project-scoped, and only sent to a pinned repository API',async()=>{
 const token='test-private-git-token',calls=[];const x=await setup({fetcher:async(url,options)=>{calls.push({url,options});return {bytes:Buffer.from(JSON.stringify({encoding:'base64',content:Buffer.from('README evidence '+token).toString('base64')}))};}});
 try{
  const credentialsPath='/api/projects/'+x.a.id+'/git-credentials';
  const configured=await x.s.handle(req(credentialsPath,x.alice,{host:'github.com',token},'PUT'));assert.equal(configured.status,200);assert.doesNotMatch(await configured.text(),new RegExp(token));
  const status=await x.s.handle(req(credentialsPath,x.alice));assert.doesNotMatch(await status.text(),new RegExp(token));
  const r=await x.s.handle(req(x.path,x.alice,{type:'git',name:'源码',url:'https://github.com/owner/repo.git',ref:'main',description:'核对规则'}));assert.equal(r.status,201);const meta=await r.json();assert.equal(meta.hasCredential,false);assert.doesNotMatch(JSON.stringify(meta),new RegExp(token));
  const row=x.p.db.prepare('SELECT * FROM project_git_credentials').get();assert.ok(row.credential);assert.equal(x.p.db.prepare('SELECT credential FROM node_resources').get().credential,null);assert.equal(Buffer.from(row.credential).includes(Buffer.from(token)),false);
  x.a.workspace.maps[0].root.resources=[meta];validateProject(x.a);const context=buildMapContext(x.a,'map','root');assert.equal(context.target.resources[0].id,meta.id);assert.equal(context.overview.references[0].nodeId,'root');assert.doesNotMatch(JSON.stringify(context),new RegExp(token));
  assert.equal((await x.s.handle(req(credentialsPath,x.bob))).status,404);
  assert.equal((await x.s.handle(req(credentialsPath,x.bob,{host:'github.com',token},'PUT'))).status,404);
  assert.equal((await x.s.handle(req(credentialsPath+'/'+row.id,x.bob,undefined,'DELETE'))).status,404);
  assert.equal((await x.s.handle(req(x.path,x.bob))).status,404);assert.equal((await x.s.handle(req(x.path+'/'+meta.id,x.bob,undefined,'DELETE'))).status,404);
  await assert.rejects(x.s.read(x.b.id,meta.id),/不存在/);
  assert.equal(x.s.credentialFor(x.b.id,meta.url),'');
  const result=await x.s.read(x.a.id,meta.id,{path:'README.md'});assert.match(result.text,/README evidence \[redacted\]/);assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);assert.match(calls[0].url,/^https:\/\/api.github.com\/repos\/owner\/repo\/contents\/README.md\?ref=main$/);
  assert.equal((await x.s.handle(req(x.path,x.alice,{type:'git',name:'bad',url:'https://user:password@github.com/owner/repo'}))).status,400);
  assert.equal((await x.s.handle(req(x.path,x.alice,{type:'git',name:'bad',url:'https://github.com/owner/repo?token=secret'}))).status,400);
  assert.equal((await x.s.handle(req(x.path,x.alice,{type:'git',name:'bad',url:'https://evil.example.org/repo',credential:token}))).status,400);
  assert.throws(()=>repositoryRequest(meta,'../secret',token),/路径/);
  assert.throws(()=>validateProject({...x.a,workspace:{...x.a.workspace,maps:[{...x.a.workspace.maps[0],root:{...x.a.workspace.maps[0].root,resources:[{...meta,credential:token}]}}]}}),/凭证/);
 }finally{x.p.close();}
});
test('uploads enforce ownership, type and size; previews support ranges; deletion cascades with project',async()=>{
 const x=await setup();try{
  const upload=bytes=>new Request(origin+x.path,{method:'POST',headers:{Cookie:x.alice,Origin:origin,'X-Branch-Request':'1','Content-Type':'image/png','X-Resource-Name':encodeURIComponent('参考图.png')},body:bytes});
  const r=await x.s.handle(upload(png));assert.equal(r.status,201);const meta=await r.json();assert.equal(meta.bytes,png.length);
  const file=x.path+'/'+meta.id+'/file';assert.equal((await x.s.handle(req(file,x.bob))).status,404);
  const preview=await x.s.handle(req(file,x.alice));assert.equal(preview.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
  const partial=await x.s.handle(req(file,x.alice,undefined,'GET',{Range:'bytes=1-5'}));assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),png.subarray(1,6));
  const update=await x.s.handle(req(x.path+'/'+meta.id,x.alice,{name:'参考图',description:'红色代表攻击区域'},'PATCH'));assert.equal(update.status,200);
  const disabled=await x.s.read(x.a.id,meta.id);assert.match(disabled.analysis,/尚未读取/);assert.equal(disabled.image,undefined);
  const enabled=await x.s.read(x.a.id,meta.id,{visionEnabled:true});assert.equal(enabled.image.data,png.toString('base64'));assert.match(enabled.description,/攻击/);
  assert.equal((await x.s.handle(upload(Buffer.from('<svg>bad</svg>')))).status,400);
  assert.equal((await x.s.handle(upload(Buffer.alloc(2*1024*1024+1)))).status,413);
  assert.equal((await x.s.handle(new Request(origin+x.path,{method:'POST',headers:{Cookie:x.alice,'Content-Type':'image/png'},body:png}))).status,403);
  await x.p.handle(req('/api/projects/'+x.a.id,x.alice,undefined,'DELETE'));assert.equal(x.p.db.prepare('SELECT count(*) AS n FROM node_resources').get().n,0);
 }finally{x.p.close();}
});
test('resource fetching rejects private DNS and credential-bearing or redirected destinations',async()=>{
 let calls=0;await assert.rejects(fetchReference('https://docs.example.org',{resolve:async()=>[{address:'127.0.0.1',family:4}],request:()=>{calls++;}}),/非公网/);assert.equal(calls,0);
 await assert.rejects(fetchReference('https://user:token@docs.example.org'),/公网 HTTPS/);
 const gitlab=repositoryRequest({url:'https://gitlab.com/group/repo',ref:'release/v1'},'src/main.js','test-token');assert.match(gitlab.url,/repository\/files\/src%2Fmain.js/);assert.equal(gitlab.headers['PRIVATE-TOKEN'],'test-token');
});


test('workspace credentials apply to multiple repositories, rotate without node changes, and survive resource deletion',async()=>{
 const headers=[];const x=await setup({fetcher:async(url,options)=>{headers.push(options.headers);return {bytes:Buffer.from('[]')};}});
 try{
  const base='/api/projects/'+x.a.id+'/git-credentials';
  const configure=token=>x.s.handle(req(base,x.alice,{host:'github.com',token},'PUT'));
  const saved=await(await configure('first-workspace-token')).json();
  const add=async name=>(await(await x.s.handle(req(x.path,x.alice,{type:'git',name,url:'https://github.com/team/'+name}))).json());
  const a=await add('repo-one'),b=await add('repo-two');await x.s.read(x.a.id,a.id);await x.s.read(x.a.id,b.id);assert.equal(headers[0].Authorization,'Bearer first-workspace-token');assert.equal(headers[1].Authorization,'Bearer first-workspace-token');
  const changed=await(await configure('rotated-workspace-token')).json();assert.equal(changed.id,saved.id);
  await x.s.handle(req(x.path+'/'+a.id,x.alice,undefined,'DELETE'));await x.s.read(x.a.id,b.id);assert.equal(headers.at(-1).Authorization,'Bearer rotated-workspace-token');
  assert.equal((await x.s.handle(req(x.path,x.alice,{type:'git',name:'old client',url:'https://github.com/team/repo',credential:'per-node-token'}))).status,400);
  const revoked=await x.s.handle(req(base+'/'+saved.id,x.alice,undefined,'DELETE'));assert.equal(revoked.status,200);await x.s.read(x.a.id,b.id);assert.equal(headers.at(-1).Authorization,undefined);
  assert.equal((await x.s.handle(new Request(origin+base,{method:'PUT',headers:{Cookie:x.alice,'Content-Type':'application/json'},body:JSON.stringify({host:'github.com',token:'test-token'})}))).status,403);
 }finally{x.p.close();}
});
test('legacy node secrets migrate atomically into the workspace, preserve distinct tokens and never reappear after revocation',async()=>{
 const x=await setup();try{
  const add=async(projectId,name,token)=>{
    const path='/api/projects/'+projectId+'/resources',r=await x.s.handle(req(path,x.alice,{type:'git',name,url:'https://github.com/team/'+name}));const meta=await r.json();
    x.p.db.prepare('UPDATE node_resources SET credential=?,metadata=? WHERE id=?').run(x.s.encrypt(token),JSON.stringify({...meta,hasCredential:true}),meta.id);return meta;
  };
  const one=await add(x.a.id,'one','legacy-token-one'),two=await add(x.a.id,'two','legacy-token-two');await add(x.b.id,'other','another-project-token');
  const service=new ResourceService(x.p,'durable-test-only-secret');
  assert.equal(service.credentialFor(x.a.id,one.url),'legacy-token-one');assert.equal(service.credentialFor(x.a.id,two.url),'legacy-token-two');assert.equal(service.credentialFor(x.a.id,'https://github.com/team/unknown'),'');assert.equal(service.credentialFor(x.b.id,one.url),'another-project-token');
  assert.equal(x.p.db.prepare('SELECT count(*) AS n FROM node_resources WHERE credential IS NOT NULL').get().n,0);
  const base='/api/projects/'+x.a.id+'/git-credentials',list=await(await service.handle(req(base,x.alice))).json();assert.equal(list.items.length,2);assert.ok(list.items.every(r=>r.legacy));assert.doesNotMatch(JSON.stringify(list),/legacy-token/);
  const configured=await(await service.handle(req(base,x.alice,{host:'github.com',token:'shared-token'},'PUT'))).json();assert.equal(service.credentialFor(x.a.id,one.url),'shared-token');assert.equal(service.credentialFor(x.a.id,two.url),'shared-token');
  await service.handle(req(base+'/'+configured.id,x.alice,undefined,'DELETE'));
  const restarted=new ResourceService(x.p,'durable-test-only-secret');assert.equal(restarted.credentialFor(x.a.id,one.url),'');assert.equal(restarted.credentialFor(x.b.id,one.url),'another-project-token');
  await x.p.handle(req('/api/projects/'+x.b.id,x.alice,undefined,'DELETE'));assert.equal(x.p.db.prepare('SELECT count(*) AS n FROM project_git_credentials').get().n,0);
 }finally{x.p.close();}
});
