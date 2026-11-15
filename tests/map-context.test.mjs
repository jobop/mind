import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMapContext } from '../runtime/map-context.mjs';
test('whole-map context includes other branches and identifies an unambiguous target ID and index',()=>{
 const project={workspace:{maps:[{id:'map',title:'游戏设计',root:{id:'root',title:'卡牌游戏',children:[{id:'selected',title:'战斗系统',note:'目标节点',children:[]},{id:'other',title:'商业模式',note:'与战斗体验有关的限制',children:[]}]}}]}};
 const context=buildMapContext(project,'map','selected');assert.equal(context.totalNodes,3);assert.equal(context.target.index,2);assert.equal(context.target.id,'selected');assert.equal(context.overview.omittedNodes,0);
 assert.ok(context.overview.outline.some(n=>n.title==='商业模式'&&n.note.includes('限制')));assert.equal(context.overview.fullTreeFile,'map-context.json');
 assert.throws(()=>buildMapContext(project,'foreign-map','selected'),e=>e.code==='TARGET_CHANGED');
});
test('large trees retain the full file data and explicitly report compressed overview omissions',()=>{
 const children=Array.from({length:1999},(_,i)=>({id:'node-'+i,title:'长标题'.repeat(20)+i,note:'备注'.repeat(100),children:[]}));
 const context=buildMapContext({workspace:{maps:[{id:'map',title:'大树',root:{id:'root',title:'主题',children}}]}},'map','node-1998');
 assert.equal(context.nodes.length,2000);assert.equal(context.target.index,2000);assert.ok(context.overview.notesTruncated);assert.ok(context.overview.omittedNodes>0);assert.ok(JSON.stringify(context.overview.outline).length<=32000);assert.ok(context.overview.outline.some(n=>n.id==='node-1998'));
});
