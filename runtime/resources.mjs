import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { publicUrl, isPublicAddress, readPublicPage } from './public-page.mjs';
import { ProjectError } from './projects.mjs';

const fail = (message, status = 400) => { throw new ProjectError(message, status, 'RESOURCE_ERROR'); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' } });
const clean = (value, max, name, empty = false) => { if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) fail(name + '格式不正确'); return value.trim(); };
export function resourceMetadata(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['id','type','name','url','description','ref','uploaded','mime','bytes','hasCredential'].includes(k))) fail('资源仅能保存公开描述，凭证请在专用输入框中填写');
  const id = clean(value.id,80,'资源 ID'), name = clean(value.name,120,'资源名称'), description = clean(value.description || '',12000,'资源说明',true);
  if (!['git','image','video','web'].includes(value.type)) fail('资源类型不支持');
  let url = '';
  if (value.url) { try { url = publicUrl(value.url).href; } catch { fail('资源链接需使用不含用户名和密码的公网 HTTPS 地址'); } if(url.length>2000)fail('资源地址过长'); }
  if (value.type === 'git' && (!url || new URL(url).search)) fail('Git 地址不能包含查询参数或凭证，请使用单独的凭证输入框');
  if (!url && !value.uploaded) fail('请填写链接或上传文件');
  const ref=clean(value.ref||'',120,'分支/版本',true);
  if(ref && !/^[\w./-]+$/.test(ref))fail('分支或版本格式不正确');
  return {id,type:value.type,name,url,description,ref,uploaded:value.uploaded===true,mime:typeof value.mime==='string'?value.mime.slice(0,80):'',bytes:Number.isInteger(value.bytes)&&value.bytes>=0?value.bytes:0,hasCredential:value.hasCredential===true};
}
export function validateNodeResources(value) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>20)fail('每个节点最多添加 20 个参考资源');
  const items=value.map(resourceMetadata);if(new Set(items.map(x=>x.id)).size!==items.length)fail('节点资源不能重复');return items;
}
export function imageMime(bytes) {
  if(bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
// DNS is checked and pinned for every request. Redirects are deliberately rejected so credentials never follow them.
export async function fetchReference(url, { headers={}, signal, limit=2*1024*1024, resolve=lookup, request=https.request }={}) {
  url=publicUrl(url);const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000);
  combined.throwIfAborted();
  const addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>combined.addEventListener('abort',()=>reject(Error('资源读取超时')),{once:true}))]);
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))fail('资源地址指向非公网服务');
  const address=addresses[0];
  return new Promise((done,reject)=>{
    const req=request(url,{method:'GET',agent:false,signal:combined,lookup(host,options,callback){options.all?callback(null,[address]):callback(null,address.address,address.family);},headers:{'User-Agent':'Mind-Reference/1.0','Accept-Encoding':'identity',...headers}},res=>{
      if(res.statusCode!==200){res.resume();reject(new ProjectError('资源服务返回 HTTP '+res.statusCode+'，请检查地址、分支与只读凭证',400,'RESOURCE_ERROR'));return;}
      if(Number(res.headers['content-length'])>limit){res.destroy();reject(new ProjectError('资源超过本次读取大小上限',413,'RESOURCE_ERROR'));return;}
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(new ProjectError('资源超过本次读取大小上限',413,'RESOURCE_ERROR'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>done({bytes:Buffer.concat(chunks),mime:String(res.headers['content-type']||'').split(';')[0]}));
    });req.on('error',reject);req.end();
  });
}
export function repositoryRequest(meta,path='',credential='',directory=false) {
  const url=publicUrl(meta.url), parts=url.pathname.replace(/\.git\/?$/,'').split('/').filter(Boolean);
  if(path.length>240||path.startsWith('/')||path.split('/').some(p=>p==='.'||p==='..')||/[\x00-\x1f\\]/.test(path))fail('仓库文件路径不正确');
  const headers={Accept:'application/json'};let endpoint;
  if(url.hostname==='github.com'&&parts.length===2){
    endpoint=new URL('https://api.github.com/repos/'+parts.map(encodeURIComponent).join('/')+'/contents/'+path.split('/').map(encodeURIComponent).join('/'));
    if(meta.ref)endpoint.searchParams.set('ref',meta.ref);if(credential)headers.Authorization='Bearer '+credential;
  }else if(url.hostname==='gitlab.com'&&parts.length>=2){
    const project=encodeURIComponent(parts.join('/'));
    endpoint=new URL('https://gitlab.com/api/v4/projects/'+project+(path&&!directory?'/repository/files/'+encodeURIComponent(path):'/repository/tree'));
    endpoint.searchParams.set('ref',meta.ref||'HEAD');if(!path||directory){endpoint.searchParams.set('per_page','100');if(path)endpoint.searchParams.set('path',path);}if(credential)headers['PRIVATE-TOKEN']=credential;
  }else fail('当前 Agent 支持读取 github.com 和 gitlab.com 仓库；其他 Git 地址可保存为参考链接');
  return {url:endpoint.href,headers};
}
export class ResourceService {
  constructor(projects,secret,{fetcher=fetchReference,pageReader=readPublicPage}={}) {
    this.pending=0;this.projects=projects;this.db=projects.db;this.key=createHash('sha256').update(secret).digest();this.fetcher=fetcher;this.pageReader=pageReader;
    this.db.exec('CREATE TABLE IF NOT EXISTS node_resources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, metadata TEXT NOT NULL, credential BLOB, data BLOB); CREATE INDEX IF NOT EXISTS resource_project ON node_resources(project_id);');
  }
  encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);}
  decrypt(value){if(!value)return '';const bytes=Buffer.from(value),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString();}
  row(projectId,id){const row=this.db.prepare('SELECT * FROM node_resources WHERE project_id=? AND id=?').get(projectId,id);if(!row)fail('资源不存在或未加入当前项目，请重新添加',404);return row;}
  async handle(request){let consuming=false;try{
    const url=new URL(request.url),match=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/resources(?:\/([a-f0-9-]{36})(\/file)?)?$/);if(!match)return json({error:'接口不存在'},404);
    const [,projectId,id,file]=match;this.projects.get(request,projectId);
    if(!['GET','HEAD'].includes(request.method)&&(request.headers.get('Origin')!==url.origin||request.headers.get('X-Branch-Request')!=='1'))fail('请求来源验证失败',403);
    if(request.method==='GET'&&!id)return json({items:this.db.prepare('SELECT metadata FROM node_resources WHERE project_id=?').all(projectId).map(r=>JSON.parse(r.metadata))});
    if(['GET','HEAD'].includes(request.method)&&file){
      const row=this.row(projectId,id),meta=JSON.parse(row.metadata);if(!row.data)fail('资源没有上传文件',404);
      const data=Buffer.from(row.data),headers={'Content-Type':meta.mime,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(meta.name),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",'Accept-Ranges':'bytes'};
      let start=0,end=data.length-1,status=200;const range=request.headers.get('Range');
      if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m||!m[1]&&!m[2])return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+data.length}});start=m[1]?Number(m[1]):Math.max(0,data.length-Number(m[2]));end=m[1]&&m[2]?Math.min(end,Number(m[2])):end;if(start>end||start>=data.length)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+data.length}});status=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+data.length;}
      headers['Content-Length']=String(end-start+1);return new Response(request.method==='HEAD'?null:data.subarray(start,end+1),{status,headers});
    }
    if(['POST','PATCH'].includes(request.method)){if(this.pending>=3)fail('上传请求繁忙，请稍后重试',429);this.pending++;consuming=true;}
    if(request.method==='PATCH'&&id){
      if(Number(request.headers.get('Content-Length'))>64000)fail('资源说明过长',413);
      const reader=request.body?.getReader(),parts=[];let size=0;if(!reader)fail('请求内容为空');
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>64000){await reader.cancel();fail('资源说明过长',413);}parts.push(value);}
      let input;try{input=JSON.parse(Buffer.concat(parts).toString());}catch{fail('资源格式不正确');}
      const row=this.row(projectId,id),meta=resourceMetadata({...JSON.parse(row.metadata),name:input.name,description:input.description});
      this.db.prepare('UPDATE node_resources SET metadata=? WHERE project_id=? AND id=?').run(JSON.stringify(meta),projectId,id);return json(meta);
    }
    if(request.method==='DELETE'&&id){this.row(projectId,id);this.db.prepare('DELETE FROM node_resources WHERE project_id=? AND id=?').run(projectId,id);return json({deleted:true});}
    if(request.method!=='POST'||id)return json({error:'不支持的请求方法'},405);
    const quota=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(data)),0) AS bytes FROM node_resources WHERE project_id=?').get(projectId);
    if(quota.n>=300)fail('每个项目最多保存 300 个资源');
    const mime=request.headers.get('Content-Type')?.split(';')[0],upload=/^(image\/(png|jpeg|webp)|video\/(mp4|webm))$/.test(mime||''),limit=upload?(mime.startsWith('image/')?2:20)*1024*1024:64000;
    if(Number(request.headers.get('Content-Length'))>limit)fail('资源超过上传大小上限',413);
    const reader=request.body?.getReader(),chunks=[];let size=0;if(!reader)fail('资源内容为空');
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail('资源超过上传大小上限',413);}chunks.push(value);}
    const bytes=Buffer.concat(chunks);let meta,token='',data=null;
    if(upload){if(quota.bytes+size>100*1024*1024)fail('项目上传文件已达到 100 MiB 上限',413);if(!size)fail('文件内容为空');if(mime.startsWith('image/')&&imageMime(bytes)!==mime)fail('图片格式不匹配，仅支持 PNG、JPEG、WebP');if(mime==='video/mp4'&&bytes.toString('ascii',4,8)!=='ftyp'||mime==='video/webm'&&!bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])))fail('视频格式不匹配，仅支持 MP4、WebM');
      let name;try{name=decodeURIComponent(request.headers.get('X-Resource-Name')||'');}catch{fail('文件名不正确');}
      meta=resourceMetadata({id:randomUUID(),type:mime.startsWith('image/')?'image':'video',name,url:'',uploaded:true,mime,bytes:size});data=bytes;
    }else{
      if(mime!=='application/json')fail('请使用支持的图片、视频文件或 JSON 链接');let input;try{input=JSON.parse(bytes.toString());}catch{fail('资源 JSON 格式不正确');}
      meta=resourceMetadata({id:randomUUID(),type:input.type,name:input.name,url:input.url,description:input.description,ref:input.ref});token=clean(input.credential||'',4000,'Git Token',true);
      if(token){if(meta.type!=='git')fail('仅 Git 仓库允许保存凭证');repositoryRequest(meta,'',token);if(/[\r\n]/.test(token))fail('凭证不能包含换行');meta.hasCredential=true;}
    }
    const current=this.db.prepare('SELECT count(*) AS n,coalesce(sum(length(data)),0) AS bytes FROM node_resources WHERE project_id=?').get(projectId);if(current.n>=300||current.bytes+(data?.length||0)>100*1024*1024)fail('项目资源数量或上传总量已达到上限',413);
    this.db.prepare('INSERT INTO node_resources VALUES(?,?,?,?,?)').run(meta.id,projectId,JSON.stringify(meta),token?this.encrypt(token):null,data);return json(meta,201);
  }catch(error){return json({error:error instanceof ProjectError?error.message:'资源操作失败，请检查文件和链接',code:'RESOURCE_ERROR'},error instanceof ProjectError?error.status:500);}finally{if(consuming)this.pending--;}}
  async read(projectId,id,{path='',directory=false,visionEnabled=false,signal}={}){
    const row=this.row(projectId,id),meta=JSON.parse(row.metadata),base={resourceId:id,title:meta.name,url:meta.url,description:meta.description,fetchedAt:new Date().toISOString(),type:meta.type};
    if(meta.type==='video')return {...base,analysis:'仅提供用户说明或字幕；尚未解析视频画面和音轨，不得声称看过视频。',text:meta.description};
    if(meta.type==='image'){
      if(!visionEnabled)return {...base,text:meta.description,analysis:'当前模型未启用图片输入，尚未读取图片内容。可依据用户说明，不能声称看过图片。'};
      const result=row.data?{bytes:Buffer.from(row.data),mime:meta.mime}:await this.fetcher(meta.url,{signal,limit:2*1024*1024});const mime=imageMime(result.bytes);if(!mime)fail('图片内容无效或格式不支持');
      return {...base,analysis:'图片已作为视觉输入提供给模型',image:{data:result.bytes.toString('base64'),mimeType:mime}};
    }
    if(meta.type==='web')return {...base,...await this.pageReader(meta.url,signal)};
    const credential=this.decrypt(row.credential),req=repositoryRequest(meta,path,credential,directory),result=await this.fetcher(req.url,{headers:req.headers,signal,limit:2*1024*1024});
    let parsed;try{parsed=JSON.parse(result.bytes.toString());}catch{fail('仓库服务没有返回可读文件信息');}
    const scrub=value=>credential?value.split(credential).join('[redacted]'):value;
    if(Array.isArray(parsed))return {...base,path,entries:parsed.slice(0,100).map(x=>({name:scrub(String(x.name||'').slice(0,240)),path:scrub(String(x.path||'').slice(0,240)),type:x.type==='dir'||x.type==='tree'?'directory':'file'}))};
    if(parsed.encoding!=='base64'||typeof parsed.content!=='string')fail('请选择仓库内的文本文件');
    const file=Buffer.from(parsed.content,'base64');if(file.includes(0))fail('此文件是二进制内容，无法作为文本参考');
    return {...base,path,text:scrub(file.toString('utf8').slice(0,16000)),truncated:file.toString('utf8').length>16000};
  }
}
