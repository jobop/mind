import { randomUUID, createHash } from 'node:crypto';
import { ProjectError, validateProject } from './projects.mjs';
const terminal = new Set(['succeeded','failed','cancelled']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const json = (data,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const safeError = error => ({ code: error?.code?.startsWith('AGENT') || ['CANCELLED','TOOLS_REQUIRED','TARGET_CHANGED','SERVER_RESTARTED'].includes(error?.code) ? error.code : 'AGENT_ERROR', message: error instanceof ProjectError || error?.code?.startsWith('AGENT') || ['CANCELLED','TOOLS_REQUIRED'].includes(error?.code) ? String(error.message).slice(0,300) : '任务执行未完成，原有导图保留，请查看执行记录' });
function findNode(node,id) { if(node.id===id)return node; for(const child of node.children){const found=findNode(child,id);if(found)return found;} return null; }
export class GenerationJobs {
  constructor(projects) {
    this.projects=projects;this.db=projects.db;this.active=new Map();this.pending=new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS generation_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,map_id TEXT NOT NULL,node_id TEXT NOT NULL,client_id TEXT NOT NULL,input_hash TEXT NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL,events TEXT NOT NULL DEFAULT '[]',result TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(owner_id,client_id));
      CREATE INDEX IF NOT EXISTS generation_job_owner ON generation_jobs(owner_id,project_id,created);
      CREATE TABLE IF NOT EXISTS generation_cancels(owner_id TEXT NOT NULL,client_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(owner_id,client_id));`);
    const error=JSON.stringify({code:'SERVER_RESTARTED',message:'服务已重启，本次未完成任务已停止；原有导图保留，请重新生成'});
    this.db.prepare("UPDATE generation_jobs SET status='failed',error=?,updated=? WHERE status IN ('queued','running')").run(error,Date.now());
    this.db.prepare('DELETE FROM generation_cancels WHERE created<?').run(Date.now()-86400000);
    this.db.prepare("DELETE FROM generation_jobs WHERE status IN ('succeeded','failed','cancelled') AND updated<?").run(Date.now()-30*86400000);
  }
  getRow(request,id) { const user=this.projects.user(request);const row=this.db.prepare('SELECT * FROM generation_jobs WHERE id=? AND owner_id=?').get(id,user.id);if(!row)throw new ProjectError('任务不存在或无权访问',404,'TASK_NOT_FOUND');return row; }
  view(row,after=0) {return {id:row.id,clientRequestId:row.client_id,projectId:row.project_id,mapId:row.map_id,nodeId:row.node_id,status:row.status,input:JSON.parse(row.input_json),events:JSON.parse(row.events).filter(e=>e.seq>after),result:row.result?JSON.parse(row.result):null,error:row.error?JSON.parse(row.error):null,created:row.created,updated:row.updated};}
  start(request,input,execute) {
    const user=this.projects.user(request), clientId=input.clientRequestId;
    if(!uuid(clientId))throw new ProjectError('任务请求 ID 格式不正确');
    input=Object.fromEntries(['clientRequestId','projectId','mapId','nodeId','topic','title','note','instruction','brief','ancestorNotes','ancestors','existing','mode','quantity','providedSources'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]));
    const serialized=JSON.stringify(input),digest=createHash('sha256').update(serialized).digest('hex');
    const prior=this.db.prepare('SELECT * FROM generation_jobs WHERE owner_id=? AND client_id=?').get(user.id,clientId);
    if(prior){if(prior.input_hash!==digest)throw new ProjectError('同一任务请求不能替换生成内容',409,'TASK_INPUT_CHANGED');return json(this.view(prior),200);}
    if(this.db.prepare('SELECT 1 FROM generation_cancels WHERE owner_id=? AND client_id=?').get(user.id,clientId))throw new ProjectError('任务已取消',409,'CANCELLED');
    const project=this.projects.get(request,input.projectId),map=project.workspace.maps.find(m=>m.id===input.mapId);
    if(!map||!findNode(map.root,input.nodeId))throw new ProjectError('目标节点不存在，请重新选择',409,'TARGET_CHANGED');
    if(this.db.prepare("SELECT 1 FROM generation_jobs WHERE owner_id=? AND status IN ('queued','running')").get(user.id))throw new ProjectError('已有任务在后台执行，请先恢复或取消该任务',429,'BUSY');
    const id=randomUUID(),now=Date.now(),controller=new AbortController();
    this.db.prepare("INSERT INTO generation_jobs(id,owner_id,project_id,map_id,node_id,client_id,input_hash,input_json,status,created,updated) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)").run(id,user.id,project.id,input.mapId,input.nodeId,clientId,digest,serialized,now,now);
    this.active.set(id,controller);
    // Deliberately detached from the HTTP request signal. No credentials are written to SQLite.
    const promise=Promise.resolve().then(async()=>{
      const events=[];
      const emit=event=>{if(events.length>=240)return;events.push({...event,seq:events.length+1});this.db.prepare('UPDATE generation_jobs SET events=?,updated=? WHERE id=?').run(JSON.stringify(events),Date.now(),id);};
      const timer=setTimeout(()=>controller.abort(),1260000);
      try{
        controller.signal.throwIfAborted();
        this.db.prepare("UPDATE generation_jobs SET status='running',updated=? WHERE id=? AND status='queued'").run(Date.now(),id);
        emit({type:'connected',at:new Date().toISOString()});
        const result=await execute(emit,controller.signal);
        controller.signal.throwIfAborted();
        this.commitResult(id,result,events);
      }catch(error){
        const row=this.db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id);
        if(row&&!terminal.has(row.status)){
          const cancelled=controller.signal.aborted;
          const restarting=controller.signal.reason?.code==='SERVER_RESTARTED';
          const failure=restarting?{code:'SERVER_RESTARTED',message:'服务已更新，本次任务已停止，请重新生成'}:cancelled?{code:'CANCELLED',message:'任务已停止，原有导图保留'}:safeError(error);
          this.db.prepare('UPDATE generation_jobs SET status=?,error=?,updated=? WHERE id=?').run(cancelled&&!restarting?'cancelled':'failed',JSON.stringify(failure),Date.now(),id);
        }
      }finally{clearTimeout(timer);this.active.delete(id);}
    });
    // Prevent a future storage error in the detached continuation from becoming an unhandled rejection.
    this.pending.add(promise);
    promise.catch(()=>{this.active.delete(id);}).finally(()=>this.pending.delete(promise));
    return json(this.view(this.db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id)),202);
  }
  async shutdown() {
    for(const controller of this.active.values())controller.abort(Object.assign(Error('Service restart'),{code:'SERVER_RESTARTED'}));
    await Promise.allSettled([...this.pending]);
  }
  commitResult(id,result,events) {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const job=this.db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id);
      if(!job||terminal.has(job.status)){this.db.exec('ROLLBACK');return;}
      const row=this.db.prepare('SELECT data,revision FROM projects WHERE id=? AND owner_id=?').get(job.project_id,job.owner_id);
      if(!row)throw new ProjectError('项目已删除，未写入生成结果',409,'TARGET_CHANGED');
      const project=JSON.parse(row.data),map=project.workspace.maps.find(m=>m.id===job.map_id),target=map&&findNode(map.root,job.node_id);
      if(!target)throw new ProjectError('目标节点已删除，未写入生成结果',409,'TARGET_CHANGED');
      const names=new Set(target.children.map(n=>n.title.trim().toLowerCase()));
      if(result.children.some(c=>names.has(c.title.trim().toLowerCase())))throw new ProjectError('目标节点已有同名分支，请检查导图后再生成',409,'TARGET_CHANGED');
      const input=JSON.parse(job.input_json),nodeIds=[];
      const children=result.children.map(c=>{
        const nodeId=randomUUID();nodeIds.push(nodeId);
        return {id:nodeId,title:c.title.trim(),note:c.note,children:[],generated:{model:result.model,at:result.generatedAt,direction:input.mode,skill:result.skill||null,skills:result.skills||[],sources:result.agent?.sources||[],generationJobId:id,agent:result.agent?{framework:result.agent.framework,version:result.agent.version,runId:result.agent.runId,modelCalls:result.agent.modelCalls,toolCalls:result.agent.toolCalls}:null}};
      });
      target.children.push(...children);target.collapsed=false;map.updated=Date.now();
      map.agentRuns=[{...result.agent,jobId:id,nodeId:job.node_id,status:'succeeded',at:result.generatedAt,model:result.model,steps:events},...(map.agentRuns||[])].slice(0,10);
      validateProject(project);
      const stored={...result,persisted:{jobId:id,projectId:job.project_id,mapId:job.map_id,nodeId:job.node_id,nodeIds,revision:row.revision+1}};
      this.db.prepare('UPDATE projects SET data=?,revision=revision+1,updated=? WHERE id=? AND owner_id=?').run(JSON.stringify(project),Date.now(),job.project_id,job.owner_id);
      this.db.prepare("UPDATE generation_jobs SET status='succeeded',result=?,updated=? WHERE id=?").run(JSON.stringify(stored),Date.now(),id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async handle(request) {
    try{
      const url=new URL(request.url),path=url.pathname,user=this.projects.user(request);
      if(request.method==='POST'&&(request.headers.get('Origin')!==url.origin||request.headers.get('X-Branch-Request')!=='1'))throw new ProjectError('请求来源验证失败',403,'INVALID_ORIGIN');
      if(path==='/api/generation-jobs'&&request.method==='GET'){
        const projectId=url.searchParams.get('projectId');this.projects.get(request,projectId);
        const rows=this.db.prepare('SELECT * FROM generation_jobs WHERE owner_id=? AND project_id=? ORDER BY created DESC LIMIT 10').all(user.id,projectId);
        return json({jobs:rows.map(row=>({id:row.id,clientRequestId:row.client_id,projectId:row.project_id,mapId:row.map_id,nodeId:row.node_id,status:row.status,input:JSON.parse(row.input_json),created:row.created,updated:row.updated}))});
      }
      const byRequest=path.match(/^\/api\/generation-jobs\/by-request\/([a-f0-9-]{36})(\/cancel)?$/);
      if(byRequest){
        const row=this.db.prepare('SELECT * FROM generation_jobs WHERE owner_id=? AND client_id=?').get(user.id,byRequest[1]);
        if(byRequest[2]&&request.method==='POST'){
          this.db.prepare('INSERT OR IGNORE INTO generation_cancels VALUES(?,?,?)').run(user.id,byRequest[1],Date.now());
          if(!row)return json({status:'cancelled'});
          return this.cancel(row);
        }
        if(request.method==='GET'){if(!row)throw new ProjectError('任务尚未创建',404,'TASK_NOT_FOUND');return json(this.view(row,Number(url.searchParams.get('after'))||0));}
      }
      const match=path.match(/^\/api\/generation-jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if(match){const row=this.getRow(request,match[1]);if(request.method==='GET'&&!match[2])return json(this.view(row,Number(url.searchParams.get('after'))||0));if(request.method==='POST'&&match[2])return this.cancel(row);}
      return json({error:'接口不存在'},404);
    }catch(error){return json({error:error instanceof ProjectError?error.message:'任务查询暂时不可用',code:error.code||'INTERNAL_ERROR'},error.status||500);}
  }
  cancel(row){
    if(!terminal.has(row.status)){
      this.db.prepare("UPDATE generation_jobs SET status='cancelled',error=?,updated=? WHERE id=?").run(JSON.stringify({code:'CANCELLED',message:'任务已取消，原有导图保留'}),Date.now(),row.id);
      this.active.get(row.id)?.abort();
    }
    return json(this.view(this.db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(row.id)));
  }
}
