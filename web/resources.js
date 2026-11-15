'use strict';
let nodeResourceDraft = [], resourceEditorSession = 0, resourceSaving = false;
const resourceTypes = {git:'Git 仓库',image:'图片',video:'视频',web:'网页'};
function prepareNodeResources(resources, visible) {
  nodeResourceDraft=clone(resources);resourceEditorSession++;
  $('nodeResourcesEditor').hidden=!visible;
  $('addNodeResource').disabled=!projectSession.project;
  $('nodeResourceLibrary').replaceChildren();renderResourceDraft();
}
function referenceFileUrl(resource) { return '/api/projects/'+projectSession.project.id+'/resources/'+encodeURIComponent(resource.id)+'/file'; }
function resourceRow(resource, remove) {
  const row=document.createElement('div');row.className='resource-row';
  const info=document.createElement('div'),name=document.createElement('b'),meta=document.createElement('small');
  name.textContent=resource.name;meta.textContent=resourceTypes[resource.type]+(resource.hasCredential?' · 已保存凭证':'')+(resource.uploaded?' · 已上传':'');info.append(name,meta);
  if(resource.description){const note=document.createElement('p');note.textContent=resource.description.slice(0,180);info.append(note);}
  const open=document.createElement('button');open.type='button';open.className='btn';open.textContent=resource.uploaded?'预览':'打开';open.onclick=()=>previewReference(resource);row.append(info,open);
  if(remove){const button=document.createElement('button');button.type='button';button.className='btn';button.textContent='移除';button.onclick=remove;row.append(button);}return row;
}
function renderResourceDraft() {
  $('nodeResourceList').replaceChildren();
  for(const resource of nodeResourceDraft)$('nodeResourceList').append(resourceRow(resource,()=>{nodeResourceDraft=nodeResourceDraft.filter(r=>r.id!==resource.id);renderResourceDraft();}));
  if(!nodeResourceDraft.length){const hint=document.createElement('p');hint.className='resource-hint';hint.textContent='还没有参考资源。资源随节点保存；项目内可复用，其他项目不可访问。';$('nodeResourceList').append(hint);}
}
function renderNodeResourceSummary(node) {
  $('selectedResources').replaceChildren();
  for(const resource of node.resources||[])$('selectedResources').append(resourceRow(resource));
}
function previewReference(resource) {
  if(!resource.uploaded){window.open(resource.url,'_blank','noopener,noreferrer');return;}
  if(!projectSession.project)return toast('请在所属项目中查看附件');
  $('resourcePreviewName').textContent=resource.name;$('resourcePreview').replaceChildren();
  const media=document.createElement(resource.type==='image'?'img':'video');media.src=referenceFileUrl(resource);media.alt=resource.name;
  if(resource.type==='video'){media.controls=true;media.preload='metadata';}
  media.onerror=()=>{const p=document.createElement('p');p.textContent='文件无法加载。跨项目导入的附件需要重新上传。';$('resourcePreview').append(p);};
  $('resourcePreview').append(media);$('resourcePreviewDialog').showModal();
}
$('resourcePreviewDialog').addEventListener('close',()=>{$('resourcePreview').replaceChildren();});
function resourceTypeChanged() {
  const type=$('resourceType').value,git=type==='git',media=type==='image'||type==='video';
  $('resourceRefField').hidden=!git;$('resourceCredentialField').hidden=!git;$('resourceFileField').hidden=!media;
  $('resourceFile').value='';$('resourceFile').accept=type==='image'?'image/png,image/jpeg,image/webp':'video/mp4,video/webm';
  $('resourceCredential').value='';
  $('resourceCapability').textContent=type==='image'?'图片可上传或填写链接。模型设置启用「支持图片输入」后，Agent 可按需读取真实图片。':type==='video'?'视频可上传播放；Agent 目前仅读取这里的说明或字幕，不自动分析画面与音轨。':git?'Agent 可读取 GitHub、GitLab.com 仓库目录和文本文件，其他 Git 地址仅作为链接参考。使用 HTTPS 地址，Token 请填在专用输入框。':'Agent 可按需提取公开网页文字；不支持网页登录态。';
}
$('addNodeResource').onclick=()=>{
  if(nodeResourceDraft.length>=20)return toast('每个节点最多添加 20 个参考资源');
  if(!projectSession.project)return toast('请先登录并选择个人项目');
  $('resourceForm').reset();$('resourceError').hidden=true;resourceTypeChanged();$('resourceDialog').showModal();
};
$('resourceType').onchange=resourceTypeChanged;
$('resourceFile').onchange=()=>{const file=$('resourceFile').files[0];if(file&&!$('resourceName').value)$('resourceName').value=file.name.slice(0,120);};
$('resourceDialog').addEventListener('cancel',event=>{if(resourceSaving)event.preventDefault();});
$('resourceDialog').addEventListener('close',()=>{$('resourceCredential').value='';$('resourceFile').value='';});
$('resourceForm').onsubmit=async event=>{
  event.preventDefault();if(resourceSaving)return;
  const projectId=projectSession.project?.id,session=resourceEditorSession;if(!projectId)return;
  const type=$('resourceType').value,file=$('resourceFile').files[0],name=$('resourceName').value.trim(),description=$('resourceDescription').value.trim(),base='/api/projects/'+projectId+'/resources';
  resourceSaving=true;$('resourceError').hidden=true;
  const buttons=[...$('resourceDialog').querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);let created;
  try{
    if(file&&['image','video'].includes(type)){
      if(file.size>(type==='image'?2:20)*1024*1024)throw Error(type==='image'?'图片需小于 2 MiB':'视频需小于 20 MiB');
      const response=await fetch(base,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'X-Branch-Request':'1','X-Resource-Name':encodeURIComponent(name)},body:file});
      const data=await response.json();if(!response.ok)throw Error(data.error||'上传失败');created=data;
      if(description)created=await api(base+'/'+created.id,{name,description},{method:'PATCH'});
    }else created=await api(base,{type,name,description,url:$('resourceUrl').value.trim(),ref:type==='git'?$('resourceRef').value.trim():'',credential:type==='git'?$('resourceCredential').value:''});
    if(projectSession.project?.id!==projectId||resourceEditorSession!==session)throw Error('当前编辑的项目已改变，请重新添加');
    nodeResourceDraft.push(created);renderResourceDraft();$('resourceCredential').value='';$('resourceDialog').close();toast('已加入待保存节点；点击节点「保存」完成关联');
  }catch(error){if(created)api(base+'/'+created.id,undefined,{method:'DELETE'}).catch(()=>{});$('resourceError').textContent=error.message;$('resourceError').hidden=false;}
  finally{resourceSaving=false;buttons.forEach(b=>b.disabled=false);}
};
$('showResourceLibrary').onclick=async()=>{
  if(!projectSession.project)return toast('请先选择个人项目');
  try{const {items}=await api('/api/projects/'+projectSession.project.id+'/resources');$('nodeResourceLibrary').replaceChildren();
    for(const r of items){const row=resourceRow(r);const add=document.createElement('button');add.type='button';add.className='btn';add.textContent=nodeResourceDraft.some(x=>x.id===r.id)?'已添加':'选用';add.disabled=nodeResourceDraft.some(x=>x.id===r.id);add.onclick=()=>{if(nodeResourceDraft.length>=20)return toast('每个节点最多 20 个资源');nodeResourceDraft.push(clone(r));renderResourceDraft();add.disabled=true;add.textContent='已添加';};row.append(add);
      const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='删除';remove.onclick=async()=>{
        if(busy)return toast('请先结束当前生成');
        if(!window.confirm('永久删除这个项目资源及其文件、凭证？所有节点将移除对此资源的关联。'))return;
        remove.disabled=true;try{await api('/api/projects/'+projectSession.project.id+'/resources/'+r.id,undefined,{method:'DELETE'});checkpoint();
          const prune=n=>{if(n.resources)n.resources=n.resources.filter(x=>x.id!==r.id);n.children.forEach(prune);};workspace.maps.forEach(m=>prune(m.root));
          nodeResourceDraft=nodeResourceDraft.filter(x=>x.id!==r.id);row.remove();renderResourceDraft();commit();toast('已删除项目资源及其凭证');
        }catch(error){toast(error.message);remove.disabled=false;}
      };row.append(remove);$('nodeResourceLibrary').append(row);}
    if(!items.length)$('nodeResourceLibrary').textContent='当前项目还没有资源。';
  }catch(error){toast(error.message);}
};

async function restoreImportedResources(root) {
  if(!projectSession.project)return;
  const base='/api/projects/'+projectSession.project.id+'/resources',library=await api(base),existing=new Map(library.items.map(r=>[r.id,r])),restored=new Map();
  async function visit(node){
    for(let i=0;i<(node.resources||[]).length;i++){
      const r=node.resources[i];
      if(existing.has(r.id)){node.resources[i]=clone(existing.get(r.id));continue;}
      if(restored.has(r.id)){node.resources[i]=clone(restored.get(r.id));continue;}
      if(r.uploaded){node.resources[i]={...r,hasCredential:false};continue;}
      const item=await api(base,{type:r.type,name:r.name,url:r.url,description:r.description,ref:r.ref||''});restored.set(r.id,item);node.resources[i]=item;
    }
    for(const child of node.children)await visit(child);
  }
  await visit(root);
}
