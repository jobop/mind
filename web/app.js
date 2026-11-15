'use strict';
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
const KEY = 'branch-ai-workspace-v1';
const palette = [
  ['#edf4ed', '#d6e4d5', '#638266'], ['#edf1fa', '#d8e0f0', '#7085ad'],
  ['#fcf3e6', '#f0dfc3', '#b18d56'], ['#f6eef7', '#e7d8ea', '#a17ea7'],
  ['#ecf5f1', '#cfe5da', '#5c967b'], ['#f9efea', '#ecdcd3', '#ad8470'],
];
function newMap(title = '我的第一个想法', note = '') {
  return { id: uid(), title, updated: Date.now(), root: { id: uid(), title, note, children: [] } };
}
function validTree(n, seen = new Set(), depth = 0) {
  if (depth > 20 || !n || typeof n.id !== 'string' || !n.id || seen.has(n.id) ||
      typeof n.title !== 'string' || !n.title.trim() || n.title.length > 80 ||
      !Array.isArray(n.children) || n.children.length > 200 ||
      n.note != null && (typeof n.note !== 'string' || n.note.length > 3000)) return false;
  seen.add(n.id);
  return seen.size <= 2000 && n.children.every(c => validTree(c, seen, depth + 1));
}
function validSkill(skill) {
  if (skill == null) return true;
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
  if (skill.id === 'custom') return typeof skill.name === 'string' && !!skill.name.trim() && skill.name.length <= 80 &&
    typeof skill.content === 'string' && !!skill.content.trim() && skill.content.length <= 12000;
  return DOMAIN_SKILLS.some(s => s.id === skill.id);
}
function normalizeSkillOrigin(origin) {
  if (!origin || origin.provider !== 'skillhub' || typeof origin.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(origin.slug) ||
      typeof origin.version !== 'string' || origin.version.length > 80 || !Array.isArray(origin.files) || origin.files.length > 4) return null;
  if (origin.files.some(f => !f || typeof f.path !== 'string' || f.path.length > 240 || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256))) return null;
  return { provider: 'skillhub', slug: origin.slug, version: origin.version, files: origin.files.map(f => ({ path: f.path, sha256: f.sha256 })), modified: origin.modified === true };
}
function validMapSettings(m) {
  return validSkill(m.skill) && (m.brief == null || typeof m.brief === 'string' && m.brief.length <= 4000);
}
function validWorkspace(w) {
  return !!w && Array.isArray(w.maps) && w.maps.length > 0 && w.maps.length <= 100 &&
    w.maps.every(m => m && typeof m.id === 'string' && typeof m.title === 'string' && m.title.trim() && m.title.length <= 80 && validTree(m.root) && validMapSettings(m)) &&
    new Set(w.maps.map(m => m.id)).size === w.maps.length;
}
let projectSession = { ready: false, user: null, project: null, projects: [], dirty: false, saving: false };
let workspace, storageOK = true;
try {
  const stored = localStorage.getItem(KEY);
  workspace = stored ? JSON.parse(stored) : null;
  if (stored && !validWorkspace(workspace)) throw Error('Invalid workspace');
} catch { workspace = null; storageOK = false; }
if (!workspace) { const m = newMap(); workspace = { maps: [m], active: m.id }; }
// Previous browser-direct model credentials are no longer used.
try { sessionStorage.removeItem('branch-ai-key'); localStorage.removeItem('branch-ai-config-v1'); } catch {}
let selected = map().root.id, mode = 'questions', view = 'map';
let zoom = 1, pan = { x: 0, y: 0 }, layout = new Map(), history = [], future = [];
let busy = false, generation = null, failedRequest = null, editAction = 'edit', editTarget = null;
let agentEvents = [], agentTraceMapId = null, agentTraceRunId = null;
const GENERATION_TIMEOUT_MS = 420000;
let generationNotice = null;
let connection = { configured: false }, connecting = false, connectController = null, toastTimer;
function map() { return workspace.maps.find(m => m.id === workspace.active) || workspace.maps[0]; }
function find(id, n = map().root, parent = null) {
  if (n.id === id) return { node: n, parent };
  for (const child of n.children) { const result = find(id, child, n); if (result) return result; }
  return null;
}
function count(n) { return 1 + n.children.reduce((total, child) => total + count(child), 0); }
function ancestors(id) {
  const path = [];
  let parent = find(id)?.parent;
  while (parent) { path.unshift(parent.title); parent = find(parent.id)?.parent; }
  return path;
}
function ancestorNotes(id) {
  const notes = [];
  let parent = find(id)?.parent;
  while (parent) { notes.unshift((parent.note || '').slice(0, 400)); parent = find(parent.id)?.parent; }
  return notes;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5000);
}
function save() {
  map().updated = Date.now();
  if (projectSession.project) { scheduleProjectSave(); return true; }
  if (!storageOK) { $('saveStatus').textContent = '未保存，请导出备份'; return false; }
  try {
    localStorage.setItem(KEY, JSON.stringify(workspace));
    $('saveStatus').innerHTML = '<i></i>已保存到本地';
    return true;
  } catch {
    $('saveStatus').textContent = '保存失败，请导出备份';
    toast('本地保存失败，请导出 JSON 备份，避免数据丢失');
    return false;
  }
}
function checkpoint() { history.push(clone(workspace)); if (history.length > 30) history.shift(); future = []; }
function commit() { save(); render(); }
function canAdd(parent, amount = 1) {
  if (ancestors(parent.id).length >= 20) { toast('已达到最大层级，请新建导图继续探索'); return false; }
  if (count(map().root) + amount > 2000 || parent.children.length + amount > 200) {
    toast('导图或当前节点的分支数量已达上限，请新建导图继续探索'); return false;
  }
  return true;
}
function switchMap(id) {
  if (busy) return toast('请先等待或取消当前生成');
  workspace.active = id;
  selected = map().root.id;
  failedRequest = null;
  commit(); fit();
}
function render() {
  const m = map();
  if (!find(selected)) selected = m.root.id;
  $('headerTitle').textContent = m.title;
  $('mapTitle').textContent = m.title;
  $('mapTitle').title = '双击重命名导图';
  $('mapCount').textContent = workspace.maps.length;
  $('mapList').replaceChildren();
  $('mobileMapSelect').replaceChildren();
  for (const item of workspace.maps) {
    const button = document.createElement('button');
    button.className = 'map-item' + (item.id === m.id ? ' selected' : '');
    const dot = document.createElement('i'), title = document.createElement('span');
    title.textContent = item.title;
    button.append(dot, title);
    button.onclick = () => switchMap(item.id);
    $('mapList').append(button);
    const option = document.createElement('option');
    option.value = item.id; option.textContent = item.title; option.selected = item.id === m.id;
    $('mobileMapSelect').append(option);
  }
  $('nodeCount').textContent = `${count(m.root)} 个节点`;
  $('undoBtn').disabled = !history.length || busy;
  $('redoBtn').disabled = !future.length || busy;
  $('deleteMap').disabled = busy;
  renderSkillPicker();
  draw(); renderInspector(); renderOutline();
}
function dimensions(n, depth) {
  const width = depth === 0 ? 190 : 180;
  const weighted = [...n.title].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 1 : .55), 0);
  const perLine = depth === 0 ? 8.5 : 12.5;
  const height = Math.max(depth === 0 ? 70 : 46, Math.ceil(weighted / perLine) * (depth === 0 ? 27 : 20) + (depth === 0 ? 46 : 22));
  return { w: width, h: height };
}
function draw() {
  layout.clear();
  const root = map().root, dim = dimensions(root, 0);
  layout.set(root.id, { x: -dim.w / 2, y: -dim.h / 2, ...dim, node: root, depth: 0, color: 0 });
  const half = Math.ceil(root.children.length / 2), sides = [root.children.slice(0, half), root.children.slice(half)];
  const heights = new Map();
  function height(n, depth) {
    const own = dimensions(n, depth).h + 28;
    const size = n.collapsed || !n.children.length ? own : Math.max(own, n.children.reduce((s, c) => s + height(c, depth + 1), 0));
    heights.set(n.id, size); return size;
  }
  function place(n, x, top, side, depth, color) {
    const size = heights.get(n.id), dim = dimensions(n, depth);
    layout.set(n.id, { x: side === 1 ? x : x - dim.w, y: top + size / 2 - dim.h / 2, ...dim, node: n, depth, color });
    if (!n.collapsed) {
      let cursor = top;
      for (const c of n.children) { place(c, x + side * 245, cursor, side, depth + 1, color); cursor += heights.get(c.id); }
    }
  }
  sides.forEach((nodes, index) => {
    const side = index === 0 ? 1 : -1;
    let top = -nodes.reduce((sum, n) => sum + height(n, 1), 0) / 2;
    nodes.forEach((n, i) => { place(n, side * 210, top, side, 1, index === 0 ? i : i + half); top += heights.get(n.id); });
  });
  $('nodes').replaceChildren(); $('edges').replaceChildren();
  for (const [id, p] of layout) {
    const n = p.node, button = document.createElement('button'), colors = palette[p.color % palette.length];
    button.className = 'node' + (p.depth === 0 ? ' root' : p.depth > 1 ? ' leaf' : '') +
      (id === selected ? ' selected' : '') + (n.generated?.model ? ' ai-node' : '') + (generation?.nodeId === id ? ' generating' : '');
    button.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;--node-bg:${colors[0]};--node-border:${colors[1]};--node-color:${colors[2]}`;
    button.textContent = n.title; button.title = n.note || n.title;
    button.setAttribute('aria-pressed', String(id === selected));
    button.setAttribute('aria-haspopup', 'menu');
    installNodeMenu(button, id);
    if (!p.depth) { const sub = document.createElement('small'); sub.textContent = '让每一个想法，生长出可能'; button.append(sub); }
    if (n.collapsed && n.children.length) { const badge = document.createElement('span'); badge.className = 'collapse-badge'; badge.textContent = '+' + n.children.length; button.append(badge); }
    button.onclick = event => { event.stopPropagation(); if (consumeLongPress(id)) return; closeContextMenu(); selected = id; draw(); renderInspector(); renderOutline(); };
    button.ondblclick = event => { event.stopPropagation(); openEdit('edit', id); };
    $('nodes').append(button);
    if (!n.collapsed) for (const child of n.children) {
      const q = layout.get(child.id); if (!q) continue;
      const right = q.x > p.x, x1 = right ? p.x + p.w : p.x, x2 = right ? q.x : q.x + q.w;
      const y1 = p.y + p.h / 2, y2 = q.y + q.h / 2, mid = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', palette[q.color % palette.length][1]);
      path.setAttribute('stroke-width', p.depth === 0 ? '2' : '1.5'); $('edges').append(path);
    }
  }
  transform();
}
function renderInspector() {
  const result = find(selected), n = result.node;
  $('selectedTitle').textContent = n.title;
  $('selectedKind').textContent = result.parent ? '当前节点' : '中心主题';
  $('selectedPath').textContent = n.note || (result.parent ? '来自 · ' + result.parent.title : '编辑主题，或直接用 AI 展开想法');
  $('collapseNode').textContent = n.collapsed ? '⊞ 展开分支' : '⊟ 折叠分支';
  $('collapseNode').disabled = !n.children.length || busy;
  $('deleteNode').disabled = !result.parent || busy;
  $('generateBtn').disabled = busy || connecting;
  $('generateBtn').textContent = busy ? '✧ Agent 正在执行…' : '✧ Agent 展开下一级 ↗';
  $('cancelGenerate').hidden = !busy;
  $('addChild').disabled = busy; $('editNode').disabled = busy;
  $('branchCount').disabled = busy; $('instruction').disabled = busy;
  document.querySelectorAll('.gen-type').forEach(button => button.disabled = busy);
  $('modeStatus').textContent = connection.configured ? '● ' + connection.model + ' · 已连接' : '○ 点击连接你的模型';
  $('modeStatus').className = 'mode-status ' + (connection.configured ? 'connected' : 'disconnected');
  $('generationError').hidden = !failedRequest;
  $('generationErrorText').textContent = failedRequest?.error || '';
  $('retryGenerate').disabled = busy;
  $('generationSource').hidden = !n.generated?.model;
  $('generationSource').textContent = n.generated?.model ? '由 ' + n.generated.model + ' 生成' + (n.generated.skill?.name ? ' · Skill：' + n.generated.skill.name : '') + (n.generated.agent ? ' · Pi Agent（' + n.generated.agent.modelCalls + ' 次模型 / ' + n.generated.agent.toolCalls + ' 次工具）' : '') + ' · ' + new Date(n.generated.at).toLocaleString('zh-CN') : '';
  $('skillSelect').disabled = busy;
  $('skillSettings').disabled = busy;
  $('skillContext').disabled = busy;
  if (!busy) restoreAgentView(n);
  renderCanvasGeneration();
}
function renderCanvasGeneration() {
  const n = find(selected)?.node;
  if (!n) return;
  const notice = generationNotice?.mapId === map().id && (generationNotice.nodeId === selected || busy) ? generationNotice : null;
  const text = notice?.text || (n.children.length ? '当前节点有 ' + n.children.length + ' 个下级节点，可继续展开' : '点击「展开下一级」，让 Agent 为选中节点生成分支');
  $('canvasGenerationStatus').textContent = text;
  $('canvasGeneration').className = 'canvas-generation' + (notice ? ' is-' + notice.state : '');
  $('canvasGenerate').disabled = busy || connecting;
  $('canvasGenerate').textContent = busy ? '正在生成…' : notice?.state === 'error' ? '重试生成' : '✧ 展开下一级';
  $('canvasGenerationDetails').hidden = !notice || !['running', 'error'].includes(notice.state);
  $('canvasCancelGeneration').hidden = !busy;
}
function renderOutline() {
  $('outline').replaceChildren();
  function walk(n, depth) {
    const button = document.createElement('button');
    button.textContent = (n.children.length ? n.collapsed ? '▸ ' : '▾ ' : '· ') + n.title;
    button.style.marginLeft = depth * 18 + 'px'; button.style.width = `calc(100% - ${depth * 18}px)`;
    if (n.id === selected) button.className = 'outline-selected';
    button.onclick = () => { selected = n.id; draw(); renderInspector(); renderOutline(); };
    button.ondblclick = () => openEdit('edit', n.id);
    $('outline').append(button);
    if (!n.collapsed) n.children.forEach(c => walk(c, depth + 1));
  }
  walk(map().root, 0);
}
function transform() {
  $('world').style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  $('zoomText').textContent = Math.round(zoom * 100) + '%';
}
function fit() {
  if (!layout.size) return;
  const all = [...layout.values()], minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x + p.w));
  const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y + p.h));
  const w = $('canvas').clientWidth, h = $('canvas').clientHeight;
  zoom = Math.max(.08, Math.min(1, (w - 65) / (maxX - minX), (h - 140) / (maxY - minY)));
  pan = { x: w / 2 - (minX + maxX) / 2 * zoom, y: h / 2 - (minY + maxY) / 2 * zoom }; transform();
}
function scale(factor) {
  const x = $('canvas').clientWidth / 2, y = $('canvas').clientHeight / 2, next = Math.max(.08, Math.min(2, zoom * factor));
  pan = { x: x - (x - pan.x) * next / zoom, y: y - (y - pan.y) * next / zoom }; zoom = next; transform();
}
let drag = null;
$('canvas').onpointerdown = e => {
  if (e.target.closest('button') || view === 'outline') return;
  drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  $('canvas').setPointerCapture(e.pointerId); $('canvas').classList.add('dragging');
};
$('canvas').onpointermove = e => { if (drag) { pan = { x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y }; transform(); } };
function endDrag() { drag = null; $('canvas').classList.remove('dragging'); }
$('canvas').onpointerup = endDrag; $('canvas').onpointercancel = endDrag;
$('canvas').addEventListener('wheel', e => { if (view !== 'map') return; e.preventDefault(); scale(e.deltaY > 0 ? .92 : 1.08); }, { passive: false });
$('zoomIn').onclick = () => scale(1.15); $('zoomOut').onclick = () => scale(1 / 1.15);
$('fitBtn').onclick = fit; $('resetView').onclick = fit;
new ResizeObserver(fit).observe($('canvasWrap'));
function openEdit(action, id = selected) {
  if (busy) return toast('请先等待或取消当前生成');
  if (action === 'new' && workspace.maps.length >= 100) return toast('最多保存 100 张导图，请先导出并整理现有导图');
  if (action === 'child' && !canAdd(find(id).node)) return;
  selected = id; editAction = action; editTarget = id;
  const n = find(id).node;
  $('editHeading').textContent = ({ new: '新建思维导图', child: '添加子节点', rename: '重命名导图', edit: '编辑节点' })[action];
  $('editTitle').value = action === 'edit' ? n.title : action === 'rename' ? map().title : '';
  $('editNote').value = action === 'edit' ? n.note || '' : '';
  $('editNote').closest('label').hidden = action === 'rename';
  $('editDialog').showModal(); setTimeout(() => $('editTitle').focus(), 50);
}
$('editForm').onsubmit = event => {
  event.preventDefault(); if (busy) return;
  const title = $('editTitle').value.trim(), note = $('editNote').value.trim();
  if (!title || title.length > 80 || note.length > 3000) return;
  if (editAction === 'child' && !canAdd(find(editTarget).node)) return;
  checkpoint();
  if (editAction === 'new') { const m = newMap(title, note); workspace.maps.unshift(m); workspace.active = m.id; selected = m.root.id; }
  else if (editAction === 'rename') map().title = title;
  else if (editAction === 'child') {
    const parent = find(editTarget).node, child = { id: uid(), title, note, children: [] };
    parent.children.push(child); parent.collapsed = false; selected = child.id;
  } else { const n = find(editTarget).node; if (n === map().root && map().title === n.title) map().title = title; n.title = title; n.note = note; }
  $('editDialog').close(); failedRequest = null; commit(); fit();
};
$('newMap').onclick = () => openEdit('new'); $('mobileNewMap').onclick = () => openEdit('new');
$('renameMap').onclick = () => openEdit('rename'); $('mapTitle').ondblclick = () => openEdit('rename');
$('mobileMapSelect').onchange = e => { switchMap(e.target.value); e.target.value = map().id; };
$('addChild').onclick = () => openEdit('child'); $('editNode').onclick = () => openEdit('edit');
$('collapseNode').onclick = () => { if (busy) return; checkpoint(); const n = find(selected).node; n.collapsed = !n.collapsed; commit(); fit(); };
$('deleteNode').onclick = () => {
  if (busy) return;
  const result = find(selected); if (!result.parent) return;
  checkpoint(); result.parent.children = result.parent.children.filter(c => c.id !== selected); selected = result.parent.id;
  failedRequest = null; commit(); fit(); toast('已删除节点及分支，可点击撤销恢复');
};
$('deleteMap').onclick = () => { if (!busy) $('deleteMapDialog').showModal(); };
$('confirmDeleteMap').onclick = () => {
  if (busy) return;
  checkpoint(); workspace.maps = workspace.maps.filter(m => m.id !== map().id);
  if (!workspace.maps.length) workspace.maps.push(newMap());
  workspace.active = workspace.maps[0].id; selected = map().root.id; failedRequest = null;
  $('deleteMapDialog').close(); commit(); fit(); toast('导图已删除，可点击撤销恢复');
};
function restore(from, to) {
  if (!from.length || busy) return;
  to.push(clone(workspace)); workspace = from.pop(); selected = map().root.id; failedRequest = null; commit(); fit();
}
$('undoBtn').onclick = () => restore(history, future); $('redoBtn').onclick = () => restore(future, history);
document.querySelectorAll('.gen-type').forEach(button => button.onclick = () => {
  if (busy) return; mode = button.dataset.mode;
  document.querySelectorAll('.gen-type').forEach(other => other.classList.toggle('active', other === button));
});
async function api(path, payload, options = {}) {
  const response = await fetch(path, {
    method: options.method || (payload === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', cache: 'no-store', signal: options.signal,
    headers: { 'Content-Type': 'application/json', 'X-Branch-Request': '1' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let data;
  try { data = await response.json(); } catch { throw Error(response.status === 401 || response.status === 403 ? '登录已过期，请刷新页面重新登录' : '服务器没有返回有效数据，请刷新后重试'); }
  if (!response.ok) { const error = Error(data.error || '请求失败，请重试'); error.code = data.code; throw error; }
  return data;
}

function renderAgentSources(sources) {
  $('agentSources').replaceChildren();
  for (const source of sources.slice(0, 5)) {
    if (typeof source.url !== 'string' || !source.url.startsWith('https://')) continue;
    const link = document.createElement('a'); link.textContent = '[' + source.id + '] ' + source.title;
    link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('agentSources').append(link);
  }
}
function agentSummary(run, prefix = '完成') {
  let text = prefix + ' · ' + (Number(run.modelCalls) || 0) + ' 次模型调用';
  if (run.recoveredFailures) text += ' · 已修复 ' + run.recoveredFailures + ' 次';
  if (run.unresolvedFailures) text += ' · ' + run.unresolvedFailures + ' 次工具失败未恢复，请查看记录';
  return text;
}
function restoreAgentView(node) {
  const requestedRun = node.generated?.agent?.runId;
  if (agentTraceMapId === map().id && (!requestedRun || requestedRun === agentTraceRunId)) return;
  agentTraceMapId = map().id;
  const runs = Array.isArray(map().agentRuns) ? map().agentRuns : [];
  const run = runs.find(r => r.runId === requestedRun) || (requestedRun ? { ...node.generated.agent, steps: [], sources: node.generated.sources || [] } : runs[0]);
  $('agentTrace').replaceChildren(); $('agentSources').replaceChildren();
  $('agentPanel').hidden = !run;
  if (!run) { agentTraceRunId = null; return; }
  agentTraceRunId = run.runId;
  $('agentRunStatus').textContent = agentSummary(run, '历史记录');
  for (const event of (Array.isArray(run.steps) ? run.steps : []).slice(-80)) {
    if (typeof event.text !== 'string') continue;
    const item = document.createElement('li'); item.textContent = event.text.slice(0, 2000); if (event.failed && !event.recovered) item.className = 'agent-failed'; $('agentTrace').append(item);
  }
  renderAgentSources(Array.isArray(run.sources) ? run.sources : []);
}
function showAgentEvent(event) {
  const labels = {
    connected: () => '已连接 Agent 服务',
    started: () => 'Pi Agent 已启动（最多 ' + event.limits.modelCalls + ' 次模型调用）',
    plan: () => '执行步骤：\n' + event.steps.map((step, i) => (i + 1) + '. ' + step).join('\n'),
    model_request: () => '模型调用 ' + event.call + ' / ' + event.max,
    tool_start: () => '开始：' + event.label,
    tool_end: () => (event.ok ? '完成：' : '工具未成功：') + event.label + (!event.ok && event.reason ? '；原因：' + event.reason : ''),
    tool_recovered: () => '已修复：' + event.label + '，后续重试成功',
    sandbox_preparing: () => '任务开始前准备 ' + event.count + ' 个项目 Skill',
    skill_prepared: () => '已准备 Skill：' + event.name + '（' + event.files + ' 个文件）',
    sandbox_creating: () => '正在创建本次任务的独立 E2B 沙箱',
    sandbox_created: () => '独立 E2B 沙箱已创建',
    sandbox_ready: () => 'Skill 文件已就绪，Pi Agent 在沙箱内开始执行',
    sandbox_destroyed: () => '本次任务沙箱已销毁',
    sandbox_cleanup_pending: () => '沙箱清理请求未确认，将由最长 5 分钟生命周期回收',
    skill_catalog: () => '已检索项目 Skill 库 · ' + event.count + ' 个可选方法',
    skill_selected: () => '本次采用 Skill：' + event.name + ' @ ' + event.version,
    source: () => '已读取证据 [' + event.id + '] ' + event.title,
    validation: () => event.valid ? '分支结构与引用校验通过' : '需要修订：' + event.issues.join('；'),
    completed: () => 'Agent 已提交经过校验的分支',
  };
  if (!labels[event.type]) return;
  if (event.type === 'tool_recovered') {
    agentEvents.forEach((previous, index) => {
      if (previous.failed && !previous.recovered && previous.tool === event.tool && event.ids?.includes(previous.id)) {
        previous.recovered = true; previous.text += '（后续已修复）';
        const item = $('agentTrace').children[index];
        if (item) { item.textContent = previous.text; item.className = ''; }
      }
    });
  }
  const text = labels[event.type]();
  if (agentEvents.length < 80) agentEvents.push({ type: event.type, id: event.id, tool: event.tool, failed: event.type === 'tool_end' && !event.ok, at: event.at || new Date().toISOString(), text: text.slice(0, 2000) });
  const item = document.createElement('li'); item.textContent = text;
  if (event.type === 'tool_end' && !event.ok) item.className = 'agent-failed';
  if (busy && generationNotice) { generationNotice.text = text.replace(/\n/g, ' ').slice(0, 200); renderCanvasGeneration(); }
  $('agentTrace').append(item); $('agentTrace').scrollTop = $('agentTrace').scrollHeight;
  $('agentRunStatus').textContent = event.type === 'completed' ? '已提交' : '执行中';
}
async function generateWithAgent(payload, signal) {
  const response = await fetch('/api/generate', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-Branch-Request': '1' }, body: JSON.stringify(payload),
  });
  if (!response.ok || !response.headers?.get('Content-Type')?.includes('application/x-ndjson')) {
    let data;
    try { data = await response.json(); } catch { throw Error('Agent 服务响应无效，请确认本地服务仍在运行'); }
    if (!response.ok) { const error = Error(data.error || 'Agent 请求失败'); error.code = data.code; throw error; }
    return data;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result = null;
  const processLine = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') { const error = Error(event.error); error.code = event.code; throw error; }
    if (event.type === 'result') result = event.result;
    else showAgentEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 300000) throw Error('Agent 消息过大，已停止读取');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) { processLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) processLine(buffer);
  } finally { await reader.cancel().catch(() => {}); }
  if (!result) throw Error('Agent 连接中断，没有提交结果，原图已保留');
  return result;
}

async function refreshConnection() {
  try { connection = await api('/api/config'); }
  catch (error) { connection = { configured: false }; toast('模型连接检查失败：' + error.message); }
  renderInspector(); return connection;
}
function requestSnapshot() {
  const n = find(selected).node;
  return {
    mapId: map().id, nodeId: n.id,
    payload: { projectId: projectSession.project?.id, topic: map().root.title, brief: map().brief || '', skill: clone(map().skill || { id: 'general' }), title: n.title, note: n.note || '', ancestors: ancestors(n.id), ancestorNotes: ancestorNotes(n.id),
      providedSources: (n.generated?.sources || []).slice(0, 5).map(s => ({ url: s.url, title: s.title })), existing: n.children.map(c => c.title), mode, quantity: Number($('branchCount').value), instruction: $('instruction').value.trim() },
  };
}
async function generate(snapshot) {
  if (busy || connecting) return;
  if (projectSession.ready && !projectSession.user) { openAccount(); return toast('请先登录，并选择属于你的项目'); }
  if (projectSession.ready && !projectSession.project) return toast('请先创建或选择项目');
  if (!connection.configured) { toast('先连接你的模型，就可以开始生成'); openSettings(); return; }
  const job = snapshot || requestSnapshot();
  const targetMap = workspace.maps.find(m => m.id === job.mapId);
  const target = targetMap && find(job.nodeId, targetMap.root)?.node;
  if (!target || map().id !== job.mapId) return toast('目标节点已变化，请重新选择节点生成');
  if (!canAdd(target, job.payload.quantity)) return;
  // A retry keeps the original target, instruction and direction, while honoring current siblings.
  job.payload.existing = target.children.map(c => c.title);
  busy = true; failedRequest = null; agentEvents = [];
  generationNotice = { mapId: job.mapId, nodeId: job.nodeId, state: 'running', text: '正在保存项目并准备生成…' };
  agentTraceMapId = map().id; agentTraceRunId = null;
  $('agentTrace').replaceChildren(); $('agentSources').replaceChildren(); $('agentPanel').hidden = false; $('agentRunStatus').textContent = '连接中';
  const controller = new AbortController();
  generation = { ...job, controller, cancelled: false };
  const current = generation;
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  render();
  try {
    if (projectSession.project) await flushProjectSave();
    const result = await generateWithAgent(job.payload, controller.signal);
    if (current.cancelled || controller.signal.aborted) return;
    if (!Array.isArray(result.children) || result.children.length !== job.payload.quantity ||
      result.children.some(c => typeof c.title !== 'string' || !c.title.trim() || c.title.length > 80 || typeof c.note !== 'string' || c.note.length > 3000)) throw Error('服务器返回的节点格式不正确，请重试');
    const seen = new Set(target.children.map(c => c.title.trim().toLowerCase()));
    for (const c of result.children) { const key = c.title.trim().toLowerCase(); if (seen.has(key)) throw Error('模型返回了重复分支，请重试'); seen.add(key); }
    checkpoint();
    target.children.push(...result.children.map(c => ({ id: uid(), title: c.title.trim(), note: c.note, children: [], generated: { skills: result.skills || [], model: result.model, at: result.generatedAt, direction: job.payload.mode, skill: result.skill || null, agent: result.agent ? { framework: result.agent.framework, version: result.agent.version, runId: result.agent.runId, modelCalls: result.agent.modelCalls, toolCalls: result.agent.toolCalls } : null, sources: result.agent?.sources || [] } })));
    target.collapsed = false; selected = target.id;
    if (result.agent) {
      agentTraceRunId = result.agent.runId;
      targetMap.agentRuns = [{ runId: result.agent.runId, model: result.model, at: result.generatedAt, plan: result.agent.plan, modelCalls: result.agent.modelCalls, toolCalls: result.agent.toolCalls, toolFailures: result.agent.toolFailures, recoveredFailures: result.agent.recoveredFailures, unresolvedFailures: result.agent.unresolvedFailures, selectedSkills: result.agent.selectedSkills || [], usage: result.agent.usage, steps: agentEvents.slice(-80), sources: result.agent.sources }, ...(targetMap.agentRuns || [])].slice(0, 10);
      $('agentRunStatus').textContent = agentSummary(result.agent);
      renderAgentSources(result.agent.sources || []);
    }
    generationNotice = { mapId: job.mapId, nodeId: job.nodeId, state: 'success', text: '已新增 ' + result.children.length + ' 个下级节点 · 当前导图共 ' + count(targetMap.root) + ' 个节点' };
    save(); fitAfterRender = true; toast('已生成 ' + result.children.length + ' 个分支，可点击新节点继续展开');
  } catch (error) {
    if (current.cancelled) { generationNotice = { mapId: job.mapId, nodeId: job.nodeId, state: 'idle', text: '已取消生成，原有节点保留' }; $('agentRunStatus').textContent = '已取消'; toast('已取消生成，原有节点已保留'); }
    else {
      const message = error.name === 'AbortError' ? '任务等待超时，未收到完整分支，请查看执行记录后重试' : error instanceof TypeError ? '网络连接中断，请检查网络后重试' : error.message;
      generationNotice = { mapId: job.mapId, nodeId: job.nodeId, state: 'error', text: message };
      failedRequest = { ...job, error: message }; $('agentRunStatus').textContent = '未完成';
      if (error.code === 'CONNECTION_REQUIRED') connection = { configured: false };
      toast(message);
    }
  } finally {
    clearTimeout(timeout); busy = false; generation = null; render();
    if (fitAfterRender) { fit(); fitAfterRender = false; }
  }
}
let fitAfterRender = false;
$('generateBtn').onclick = () => generate();
$('canvasGenerate').onclick = () => generate(failedRequest && failedRequest.mapId === map().id && failedRequest.nodeId === selected ? failedRequest : undefined);
$('canvasGenerationDetails').onclick = () => $('agentPanel').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
$('canvasCancelGeneration').onclick = () => $('cancelGenerate').onclick();
$('retryGenerate').onclick = () => { if (failedRequest) generate(failedRequest); };
$('cancelGenerate').onclick = () => { if (generation) { generation.cancelled = true; generation.controller.abort(); } };
const presets = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow: { base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
};
function openSettings() {
  if ($('settingsDialog').open) return;
  $('apiBase').value = connection.base || '';
  $('modelName').value = connection.model || '';
  $('apiKey').value = '';
  $('apiKey').placeholder = connection.configured ? '已安全保存；保持地址不变可留空沿用' : '请输入你的 API Key';
  $('providerPreset').value = Object.keys(presets).find(k => presets[k].base === connection.base) || 'custom';
  $('connectionError').hidden = true;
  updateConnectionState(); $('settingsDialog').showModal();
}
function updateConnectionState() {
  $('connectionState').textContent = connection.configured ? '● 已连接 · ' + connection.model : '○ 尚未连接，请填写接口信息';
  $('connectionState').className = 'connection-state' + (connection.configured ? ' ready' : '');
  $('disconnectModel').hidden = !connection.configured || connection.source === 'server';
}
$('settingsBtn').onclick = openSettings; $('mobileSettings').onclick = openSettings; $('modeStatus').onclick = openSettings;
$('providerPreset').onchange = e => {
  const preset = presets[e.target.value];
  if (preset) { $('apiBase').value = preset.base; $('modelName').value = preset.model; }
  else { $('apiBase').value = ''; $('modelName').value = ''; }
  $('apiKey').value = '';
};
function connectionControls(disabled) {
  for (const id of ['connectModel', 'disconnectModel', 'apiBase', 'modelName', 'apiKey', 'providerPreset']) $(id).disabled = disabled;
  $('connectModel').textContent = disabled ? '正在验证真实连接…' : '连接并验证';
}
$('settingsForm').onsubmit = async e => {
  e.preventDefault(); if (connecting) return;
  if (busy) return toast('请先等待或取消当前生成，再修改模型连接');
  const input = { base: $('apiBase').value.trim(), model: $('modelName').value.trim(), key: $('apiKey').value.trim() };
  if (!input.base || !input.model || !input.key && (!connection.configured || connection.base !== input.base.replace(/\/$/, '').replace(/\/chat\/completions$/, ''))) {
    $('connectionError').textContent = '请填写接口地址、模型名称和 API Key'; $('connectionError').hidden = false; return;
  }
  connecting = true; connectionControls(true); renderInspector(); $('connectionError').hidden = true;
  connectController = new AbortController();
  const timeout = setTimeout(() => connectController?.abort(), 35000);
  try {
    await api('/api/connection', input, { signal: connectController.signal });
    $('apiKey').value = ''; input.key = '';
    // Confirm that the browser accepted the encrypted HttpOnly cookie.
    connection = await api('/api/config');
    if (!connection.configured) throw Error('浏览器未保存连接凭据，请允许本站 Cookie 后重试');
    updateConnectionState(); $('settingsDialog').close(); toast('模型连接已验证，现在可以生成真实分支');
  } catch (error) {
    if (!$('settingsDialog').open) return;
    const message = error.name === 'AbortError' ? '工具能力验证超时，请检查接口后重试' : error instanceof TypeError ? '网络连接失败，请稍后重试' : error.message;
    $('connectionError').textContent = message; $('connectionError').hidden = false;
  } finally {
    clearTimeout(timeout); input.key = ''; connecting = false; connectController = null; connectionControls(false); renderInspector();
  }
};
$('disconnectModel').onclick = async () => {
  if (busy || connecting) return;
  try {
    await api('/api/connection', undefined, { method: 'DELETE' });
    connection = await api('/api/config'); $('apiKey').value = ''; updateConnectionState(); renderInspector(); toast('已清除当前浏览器的模型连接');
  } catch (error) { toast(error.message); }
};
$('settingsDialog').addEventListener('close', () => { connectController?.abort(); $('apiKey').value = ''; });
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$('helpBtn').onclick = () => $('helpDialog').showModal();
function download(data, filename, type) {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([data], { type }));
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportBtn').onclick = () => {
  download(JSON.stringify({ format: 'branch-ai', version: 1, projectSkills: projectSession.project?.skills || [], projectBrief: projectSession.project?.brief || '', map: map() }, null, 2), map().title.replace(/[\\/:*?"<>|]/g, '_') + '.json', 'application/json');
  toast('已导出当前导图，备份中不包含模型密钥');
};
$('importBtn').onclick = () => $('importFile').click();
$('mobileImport').onclick = () => $('importFile').click();
$('mobileDelete').onclick = () => { if (!busy) $('deleteMapDialog').showModal(); };
$('importFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (busy) throw Error('请先等待或取消当前生成');
    if (workspace.maps.length >= 100) throw Error('导图数量已达上限，请先整理现有导图');
    if (file.size > 5 * 1024 * 1024) throw Error('请导入 5MB 以内的 JSON 文件');
    const data = JSON.parse(await file.text()), item = data.map;
    if (data.format !== 'branch-ai' || data.version !== 1 || !item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 80 || !validTree(item.root) || !validMapSettings(item)) throw Error('文件格式不正确，请选择枝想导出的 JSON 导图');
    function sanitize(n) {
      const node = { id: uid(), title: n.title.trim(), note: n.note || '', collapsed: n.collapsed === true, children: n.children.map(sanitize) };
      if (n.generated && typeof n.generated.model === 'string' && n.generated.model.length <= 150 && typeof n.generated.at === 'string' && Number.isFinite(Date.parse(n.generated.at))) {
        node.generated = { model: n.generated.model, at: n.generated.at, direction: n.generated.direction === 'solutions' ? 'solutions' : 'questions' };
        if (n.generated.agent?.framework === 'pi-agent-core') node.generated.agent = { framework: 'pi-agent-core', version: String(n.generated.agent.version || '').slice(0, 30), runId: String(n.generated.agent.runId || '').slice(0, 80), modelCalls: Number(n.generated.agent.modelCalls) || 0, toolCalls: Number(n.generated.agent.toolCalls) || 0 };
        if (Array.isArray(n.generated.sources)) node.generated.sources = n.generated.sources.filter(s => s && typeof s.url === 'string' && s.url.length <= 2000 && /^https:\/\//.test(s.url) && typeof s.title === 'string' && s.title.length <= 200).slice(0, 5).map(s => ({ id: String(s.id || '').slice(0, 12), url: s.url, title: s.title, fetchedAt: String(s.fetchedAt || '').slice(0, 40) }));
        if (n.generated.skill && typeof n.generated.skill.name === 'string' && n.generated.skill.name.length <= 80) node.generated.skill = { id: String(n.generated.skill.id || '').slice(0,80), name: n.generated.skill.name, version: String(n.generated.skill.version || '').slice(0,30) };
      }
      return node;
    }
    const imported = { id: uid(), title: item.title.trim(), updated: Date.now(), root: sanitize(item.root), brief: item.brief || '', skill: item.skill?.id === 'custom' ? { id: 'custom', name: item.skill.name, content: item.skill.content, origin: normalizeSkillOrigin(item.skill.origin) } : { id: item.skill?.id || 'general' } };
    if (projectSession.project && typeof importProjectSkills === 'function') importProjectSkills(data.projectSkills, item.skill);
    checkpoint(); workspace.maps.unshift(imported); workspace.active = imported.id; selected = imported.root.id; failedRequest = null;
    commit(); fit(); toast('导图已导入');
  } catch (error) { toast(error instanceof SyntaxError ? 'JSON 文件无法读取，请检查文件内容' : error.message); }
  e.target.value = '';
};
function switchView(next) {
  view = next; $('world').hidden = next === 'outline'; $('outline').hidden = next !== 'outline';
  $('mapView').classList.toggle('selected', next === 'map'); $('outlineView').classList.toggle('selected', next === 'outline');
  $('canvas').style.cursor = next === 'map' ? 'grab' : 'default';
}
$('mapView').onclick = () => switchView('map'); $('outlineView').onclick = () => switchView('outline');
$('allMaps').onclick = () => toast('左侧可切换导图，点击「新建思维导图」开始新的思考');
document.addEventListener('keydown', e => {
  if (!$('contextMenu').hidden) return;
  if (e.target.matches('input,textarea,select') || document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!busy) (e.shiftKey ? $('redoBtn') : $('undoBtn')).click(); }
  if (e.key === 'Escape' && !busy) { selected = map().root.id; render(); }
});

let skillDraftOrigin = null;
function effectiveSkill() {
  const saved = map().skill;
  return saved?.id === 'custom' ? saved : DOMAIN_SKILLS.find(s => s.id === saved?.id) || DOMAIN_SKILLS[0];
}
function skillOptions(select, selectedId, customLabel = '自定义 / 导入 Skill') {
  select.replaceChildren();
  for (const skill of [...DOMAIN_SKILLS, { id: 'custom', name: customLabel }]) {
    const option = document.createElement('option'); option.value = skill.id; option.textContent = skill.name;
    option.selected = skill.id === selectedId; select.append(option);
  }
  select.value = selectedId;
}
function renderSkillPicker() {
  if (projectSession.project) {
    $('skillSelect').hidden = true;
    const enabled = projectSession.project.skills.filter(s => s.enabled !== false);
    $('skillSummary').textContent = '项目内已启用 ' + enabled.length + ' 个 Skill，Agent 会按当前任务选择并读取。';
    $('skillContext').textContent = '管理项目 Skill 库 / 项目背景 ↗';
    return;
  }
  const skill = effectiveSkill();
  skillOptions($('skillSelect'), skill.id, map().skill?.id === 'custom' ? map().skill.name : '＋ 自定义 / 导入 Skill');
  $('skillSummary').textContent = skill.description || '使用当前导图保存的自定义方法论。';
  $('skillContext').textContent = map().brief ? '已补充项目背景 · 查看 / 编辑 ↗' : '补充项目背景 / 导入 Skill ↗';
}
function openSkillSettings() {
  if (projectSession.project) return openProjectSkills();
  if (busy) return toast('请先等待或取消当前生成');
  closeContextMenu();
  const skill = effectiveSkill();
  skillDraftOrigin = normalizeSkillOrigin(skill.origin);
  skillOptions($('skillPreset'), skill.id);
  $('skillName').value = skill.name; $('skillContent').value = skill.content;
  $('projectBrief').value = map().brief || ''; updateSkillCount(); renderSkillOrigin();
  $('skillDialog').showModal();
}
function updateSkillCount() { $('skillCharCount').textContent = $('skillContent').value.length + ' / 12000'; }
function renderSkillOrigin() {
  $('skillOrigin').hidden = !skillDraftOrigin;
  $('skillOrigin').textContent = skillDraftOrigin ? '来源：腾讯 SkillHub / ' + skillDraftOrigin.slug + ' @ ' + skillDraftOrigin.version + (skillDraftOrigin.modified ? '（已修改）' : '') : '';
}
$('skillSettings').onclick = openSkillSettings; $('skillContext').onclick = openSkillSettings;
$('skillSelect').onchange = e => {
  if (busy) return;
  if (e.target.value === 'custom') { openSkillSettings(); renderSkillPicker(); return; }
  if (!DOMAIN_SKILLS.some(s => s.id === e.target.value)) return;
  checkpoint(); map().skill = { id: e.target.value }; failedRequest = null; commit();
};
$('skillPreset').onchange = e => {
  const skill = DOMAIN_SKILLS.find(s => s.id === e.target.value);
  if (skill) { $('skillName').value = skill.name; $('skillContent').value = skill.content; skillDraftOrigin = null; renderSkillOrigin(); }
  updateSkillCount();
};
function markCustomSkill() { $('skillPreset').value = 'custom'; if (skillDraftOrigin) skillDraftOrigin.modified = true; updateSkillCount(); renderSkillOrigin(); }
$('skillName').oninput = markCustomSkill; $('skillContent').oninput = markCustomSkill;
$('skillForm').onsubmit = e => {
  e.preventDefault(); if (busy) return;
  if (projectSession.project) return saveProjectSkill();
  const name = $('skillName').value.trim(), content = $('skillContent').value.trim(), brief = $('projectBrief').value.trim();
  if (!name || name.length > 80 || !content || content.length > 12000 || brief.length > 4000) return toast('请检查 Skill 名称、内容及项目背景的长度');
  const builtin = DOMAIN_SKILLS.find(s => s.name === name && s.content === content);
  checkpoint(); map().skill = builtin ? { id: builtin.id } : { id: 'custom', name, content, origin: normalizeSkillOrigin(skillDraftOrigin) }; map().brief = brief;
  failedRequest = null; $('skillDialog').close(); commit(); toast('Skill 和项目背景已应用，新生成的分支会使用这些指导');
};
function parseSkillMarkdown(text, filename) {
  let content = text.replace(/^\uFEFF/, '').trim();
  let name = filename.replace(/\.(md|markdown|txt)$/i, '');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) {
    const declared = frontmatter[1].match(/^name:\s*(.+)$/m);
    if (declared) name = declared[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    content = content.slice(frontmatter[0].length).trim();
  }
  const heading = content.match(/^#\s+(.+)$/m);
  if ((!name || /^skill$/i.test(name)) && heading) name = heading[1].trim();
  name = name.slice(0, 80);
  if (!name || !content || content.length > 12000) throw Error('Skill 内容应为 1–12000 个字符，文件需有名称或一级标题');
  return { id: 'custom', name, content };
}
$('importSkill').onclick = () => $('skillFile').click();
$('skillFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 64000) throw Error('Skill 文件不能超过 64KB，请精简方法论内容');
    const skill = parseSkillMarkdown(await file.text(), file.name);
    skillDraftOrigin = null; renderSkillOrigin();
    $('skillPreset').value = 'custom'; $('skillName').value = skill.name; $('skillContent').value = skill.content;
    updateSkillCount(); toast('已读取 Skill，请检查内容后点击「应用到当前导图」');
  } catch (error) { toast(error.message); }
  e.target.value = '';
};
$('exportSkill').onclick = () => {
  const name = $('skillName').value.trim() || '领域方法论';
  const text = '---\nname: ' + JSON.stringify(name) + '\n---\n\n' + $('skillContent').value.trim() + '\n';
  download(text, name.replace(/[\\/:*?"<>|]/g, '_') + '.md', 'text/markdown;charset=utf-8');
};
let menuAnchor = null, longPressedNode = null, longPressedAt = 0;
function consumeLongPress(id) { return longPressedNode === id && Date.now() - longPressedAt < 900; }
function closeContextMenu(restoreFocus = false) {
  $('contextMenu').hidden = true;
  if (restoreFocus && menuAnchor?.isConnected) menuAnchor.focus();
  menuAnchor = null;
}
function installNodeMenu(button, id) {
  button.oncontextmenu = e => openContextMenu(e, id);
  button.onkeydown = e => {
    if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') {
      const rect = button.getBoundingClientRect();
      openContextMenu({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, currentTarget: button, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, id);
    }
  };
  let timer, start;
  button.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    start = { x: e.clientX, y: e.clientY }; clearTimeout(timer);
    timer = setTimeout(() => {
      longPressedNode = id; longPressedAt = Date.now();
      openContextMenu({ clientX: start.x, clientY: start.y, currentTarget: button, preventDefault() {}, stopPropagation() {} }, id);
    }, 550);
  });
  button.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer); });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(event, () => clearTimeout(timer));
}
function chooseDirection(direction) {
  mode = direction;
  document.querySelectorAll('.gen-type').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
}
function openContextMenu(event, nodeId = null) {
  event.preventDefault(); event.stopPropagation();
  if (document.querySelector('dialog[open]')) return;
  const result = nodeId ? find(nodeId) : null;
  if (nodeId && !result) return;
  menuAnchor = event.currentTarget;
  if (result) { selected = nodeId; renderInspector(); renderOutline(); }
  const menu = $('contextMenu'); menu.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'menu-heading'; heading.textContent = result ? result.node.title : '画布操作'; menu.append(heading);
  function item(label, action, disabled = false, danger = false) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = disabled;
    button.setAttribute('role', 'menuitem'); if (danger) button.className = 'danger';
    button.onclick = () => { if (button.disabled) return; closeContextMenu(); action(); };
    menu.append(button);
  }
  function separator() { const line = document.createElement('div'); line.className = 'menu-separator'; line.setAttribute('role', 'separator'); menu.append(line); }
  if (result) {
    item('✧ 生成子问题', () => { chooseDirection('questions'); generate(); }, busy || connecting);
    item('◇ 生成解决方案', () => { chooseDirection('solutions'); generate(); }, busy || connecting);
    separator();
    item('＋ 添加子节点', () => openEdit('child', nodeId), busy);
    item('✎ 编辑节点', () => openEdit('edit', nodeId), busy);
    item(result.node.collapsed ? '⊞ 展开分支' : '⊟ 折叠分支', () => $('collapseNode').click(), busy || !result.node.children.length);
    item('⌫ 删除节点及分支', () => $('deleteNode').click(), busy || !result.parent, true);
  } else {
    item('⛶ 居中并适应画布', fit);
    item('↶ 撤销', () => $('undoBtn').click(), busy || !history.length);
    item('↷ 重做', () => $('redoBtn').click(), busy || !future.length);
    separator(); item('＋ 新建思维导图', () => openEdit('new'), busy);
  }
  separator(); item('⚙ 领域 Skill 与项目背景', openSkillSettings, busy);
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8)) + 'px';
  menu.style.maxHeight = (window.innerHeight - 16) + 'px'; menu.style.overflowY = 'auto';
  menu.querySelector('button:not(:disabled)')?.focus();
  draw();
}
$('canvas').oncontextmenu = e => { if (!e.target.closest('.node') && view === 'map') openContextMenu(e); };
document.addEventListener('pointerdown', e => { if (!$('contextMenu').hidden && !$('contextMenu').contains(e.target)) closeContextMenu(); });
document.addEventListener('keydown', e => {
  const menu = $('contextMenu'); if (menu.hidden) return;
  if (e.key === 'Escape' || e.key === 'Tab') { closeContextMenu(true); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
});
window.addEventListener('resize', () => closeContextMenu());

render(); requestAnimationFrame(fit);
if (storageOK) save(); else { $('saveStatus').textContent = '未保存，请导出备份'; toast('本地数据无法读取，已暂缓自动覆盖；请先导出备份或检查浏览器存储权限'); }
refreshConnection();
