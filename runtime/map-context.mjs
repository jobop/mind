import { createHash } from 'node:crypto';
export function buildMapContext(project,mapId,nodeId) {
  const map=project.workspace.maps.find(m=>m.id===mapId);if(!map)throw Object.assign(Error('当前导图不存在'),{status:409,code:'TARGET_CHANGED'});
  const nodes=[];
  function visit(node,parentId=null,path=[]){const record={index:nodes.length+1,id:node.id,parentId,title:node.title,note:node.note||'',path:[...path],children:node.children.map(c=>({id:c.id,title:c.title}))};nodes.push(record);node.children.forEach(c=>visit(c,node.id,[...path,node.id]));}
  visit(map.root);
  const target=nodes.find(n=>n.id===nodeId);if(!target)throw Object.assign(Error('当前节点不存在'),{status:409,code:'TARGET_CHANGED'});
  const snapshotId=createHash('sha256').update(JSON.stringify(nodes)).digest('hex').slice(0,16);
  // Full data is available in the task file and read_map_node. The initial model context is explicitly bounded.
  let outline=nodes.map(({index,id,parentId,title,note})=>({index,id,parentId,title,note:note.slice(0,160)})),notesTruncated=nodes.some(n=>n.note.length>160),omittedNodes=0;
  if(JSON.stringify(outline).length>32000){outline=nodes.map(({index,id,parentId,title})=>({index,id,parentId,title}));notesTruncated=true;}
  if(JSON.stringify(outline).length>32000){
    const important=new Set([target.id,...target.path,...target.children.map(c=>c.id)]),chosen=nodes.filter(n=>important.has(n.id)),rest=nodes.filter(n=>!important.has(n.id));
    outline=[];let size=2;
    for(const n of [...chosen,...rest]){const entry={index:n.index,id:n.id,parentId:n.parentId,title:n.title},length=JSON.stringify(entry).length+1;if(size+length>32000)continue;outline.push(entry);size+=length;}
    outline.sort((a,b)=>a.index-b.index);omittedNodes=nodes.length-outline.length;
  }
  return {mapId:map.id,mapTitle:map.title,rootTitle:map.root.title,snapshotId,totalNodes:nodes.length,target,nodes,overview:{mapId:map.id,mapTitle:map.title,snapshotId,totalNodes:nodes.length,target:{index:target.index,id:target.id,title:target.title,path:target.path},outline,notesTruncated,omittedNodes,fullTreeFile:'map-context.json',hint:omittedNodes?'部分节点因上下文预算未在预览列出；完整树在 map-context.json，可用 read_map_node 按 ID 或序号查询。':'此概览包含整棵树的所有节点；较长备注可用 read_map_node 按 ID 或序号读取。'}};
}
