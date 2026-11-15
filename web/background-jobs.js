'use strict';
function backgroundDelay(ms,signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
function adoptServerProject(project,mapId,nodeId) {
  if(projectSession.project?.id!==project.id)throw Error('项目已切换，请重新打开任务所属项目');
  if(!validWorkspace(project.workspace))throw Error('服务器项目数据格式不正确');
  projectSession.project=project;projectSession.dirty=false;
  workspace=project.workspace;workspace.active=workspace.maps.some(m=>m.id===mapId)?mapId:workspace.active;
  selected=find(nodeId,map().root)?.node.id||map().root.id;
  renderProjects();$('saveStatus').textContent='已保存到个人项目';
}
async function generateBackgroundJob(payload,signal,resumeTask) {
  let taskId=resumeTask?.id,cursor=0,failures=0,reconnecting=false;
  const request=async(path,data)=>api(path,data,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  while(!signal.aborted){
    try {
      let task;
      if(taskId)task=await request('/api/generation-jobs/'+taskId+'?after='+cursor);
      else {
        try{task=await request('/api/generation-jobs/by-request/'+payload.clientRequestId+'?after='+cursor);}
        catch(error){if(error.status!==404)throw error;task=await request('/api/generate',payload);}
        taskId=task.id;
      }
      if(generation)generation.taskId=taskId;
      failures=0;reconnecting=false;
      for(const event of task.events||[]){if(event.seq<=cursor)continue;cursor=event.seq;showAgentEvent(event);}
      if(task.status==='succeeded'){
        showAgentEvent({type:'task_saved'});
        const project=await request('/api/projects/'+task.projectId);
        return {...task.result,persistedProject:project};
      }
      if(['failed','cancelled'].includes(task.status)){
        const error=Error(task.error?.message||'任务未完成，原有导图保留');error.code=task.error?.code||'AGENT_ERROR';error.terminal=true;throw error;
      }
      await backgroundDelay(1500,signal);
    }catch(error){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      const transient=error.isTransportError||['AbortError','TimeoutError'].includes(error.name)||error.status>=500||[408,429].includes(error.status);
      if(error.terminal||!transient)throw error;
      if(error.code==='BUSY')throw error;
      if(!reconnecting){showAgentEvent({type:'transport_reconnecting'});reconnecting=true;}
      await backgroundDelay(Math.min(8000,1000*2**Math.min(++failures,3)),signal);
    }
  }
  throw new DOMException('Aborted','AbortError');
}
async function recoverProjectGeneration() {
  if(!projectSession.project||!projectSession.user||busy)return;
  const projectId=projectSession.project.id;
  busy=true;renderInspector();
  try{
    const listing=await api('/api/generation-jobs?projectId='+encodeURIComponent(projectId));
    if(projectSession.project?.id!==projectId)return;
    const active=listing.jobs.find(job=>['queued','running'].includes(job.status));
    busy=false;
    if(active){
      if(!workspace.maps.some(m=>m.id===active.mapId))return;
      workspace.active=active.mapId;selected=active.nodeId;render();
      toast('正在恢复后台任务，不会重复调用模型');
      // The server already owns this task; reconnect without requiring a fresh model credential.
      void generate({mapId:active.mapId,nodeId:active.nodeId,payload:active.input},active);
      return;
    }
    const latest=listing.jobs[0];
    if(latest?.status==='succeeded'){
      const project=await api('/api/projects/'+projectId);
      if(projectSession.project?.id!==projectId)return;
      if(!projectSession.dirty)adoptServerProject(project,map().id,selected);
    }else if(latest&&['failed','cancelled'].includes(latest.status)){
      const task=await api('/api/generation-jobs/'+latest.id);
      if(projectSession.project?.id!==projectId)return;
      const steps=(task.events||[]).map(event=>({type:event.type,id:event.id,tool:event.tool,failed:event.type==='tool_end'&&!event.ok,text:agentEventText(event)})).filter(event=>event.text);
      currentAttempt={id:'job:'+task.id,mapId:task.mapId,nodeId:task.nodeId,status:task.status==='cancelled'?'已取消':'本次未完成',steps,sources:[]};
      generationNotice={mapId:task.mapId,nodeId:task.nodeId,state:'error',text:task.error?.message||'上次任务未完成，原有导图保留'};
      agentTraceMapId=null;
      const input={...task.input};delete input.clientRequestId;
      failedRequest={mapId:task.mapId,nodeId:task.nodeId,payload:input,error:generationNotice.text};
    }
  }catch(error){if(error.status!==404)toast('后台任务状态暂时无法查询，连接恢复后可刷新重试');}
  finally{if(!generation){busy=false;render();fit();}}
}
