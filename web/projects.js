'use strict';
let projectSaveTimer, projectSavePromise = null, projectSaveError = null, skillEditingId = null;
function defaultProject(name = '我的项目', existingWorkspace = null) {
  const m = newMap();
  return { name, brief: '', skills: [clone(DOMAIN_SKILLS[0])], workspace: existingWorkspace || { maps: [m], active: m.id } };
}
function renderProjects() {
  $('accountLabel').textContent = projectSession.user ? projectSession.user.username : '登录 / 注册';
  $('logoutAccount').hidden = !projectSession.user;
  $('projectSelect').replaceChildren();
  for (const p of projectSession.projects) {
    const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; option.selected = p.id === projectSession.project?.id; $('projectSelect').append(option);
  }
  $('projectManageSelect').replaceChildren();
  for (const p of projectSession.projects) { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; option.selected = p.id === projectSession.project?.id; $('projectManageSelect').append(option); }
  $('projectSelect').disabled = busy || !projectSession.projects.length;
  $('projectOwner').textContent = projectSession.user ? projectSession.user.username + ' 的个人项目' : '登录后保存到个人项目';
  $('mobileProjectName').textContent = projectSession.project?.name || '个人项目';
  $('projectNameLabel').textContent = projectSession.project?.name || '本地导图 · 待迁移';
  $('migrateLocal').hidden = !projectSession.user;
  $('projectSkillsBtn').disabled = !projectSession.project || busy;
}
function scheduleProjectSave() {
  projectSession.dirty = true; projectSaveError = null;
  $('saveStatus').textContent = '等待保存到个人项目…';
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => flushProjectSave().catch(error => { $('saveStatus').textContent = '未同步 · 点击重试'; toast(error.message); }), 500);
}
async function flushProjectSave() {
  clearTimeout(projectSaveTimer);
  if (projectSavePromise) await projectSavePromise;
  if (!projectSession.project || !projectSession.dirty) {
    if (projectSaveError) throw projectSaveError;
    return;
  }
  const project = projectSession.project, projectId = project.id, userId = projectSession.user?.id;
  const payload = clone({ ...project, workspace });
  projectSession.dirty = false;
  projectSavePromise = (async () => {
    try {
      const saved = await api('/api/projects/' + projectId, payload, { method: 'PUT' });
      if (projectSession.project?.id !== projectId || projectSession.user?.id !== userId) return;
      project.revision = saved.revision; project.updated = saved.updated;
      const summary = projectSession.projects.find(p => p.id === projectId);
      if (summary) { summary.name = project.name; summary.skillCount = project.skills.length; }
      projectSaveError = null; $('saveStatus').textContent = projectSession.dirty ? '等待保存…' : '已保存到个人项目';
    } catch (error) {
      projectSaveError = error; projectSession.dirty = true;
      $('saveStatus').textContent = '未同步 · 点击重试'; throw error;
    } finally { projectSavePromise = null; }
  })();
  await projectSavePromise;
  if (projectSession.dirty) return flushProjectSave();
}
async function loadProjects(selectId) {
  const data = await api('/api/projects'); projectSession.projects = data.projects;
  let remembered; try { remembered = localStorage.getItem('mind-active-project:' + projectSession.user.id); } catch {}
  if (data.projects.length) await selectProject(selectId || (data.projects.some(p => p.id === remembered) ? remembered : data.projects[0].id), true);
  else { projectSession.project = null; renderProjects(); openNewProject(); }
}
async function selectProject(id, initial = false) {
  if (busy) return toast('请先等待或取消当前生成');
  if (!initial) await flushProjectSave();
  const project = await api('/api/projects/' + id);
  if (!validWorkspace(project.workspace)) throw Error('项目数据格式不正确，请先导出备份');
  try { localStorage.setItem('mind-active-project:' + projectSession.user.id, project.id); } catch {}
  projectSession.project = project; projectSession.dirty = false; projectSaveError = null;
  workspace = project.workspace; selected = map().root.id; history = []; future = []; failedRequest = null; agentTraceMapId = null;
  renderProjects(); render(); fit(); $('saveStatus').textContent = '已保存到个人项目';
}
function openAccount() { if (busy || connecting) return toast('请先结束当前操作'); $('authError').hidden = true; $('accountDialog').showModal(); }
$('accountBtn').onclick = openAccount;
$('authForm').onsubmit = async event => {
  event.preventDefault(); if ($('authSubmit').disabled) return;
  $('authSubmit').disabled = true; $('authError').hidden = true;
  try {
    await flushProjectSave();
    const result = await api('/api/auth/' + $('authMode').value, { username: $('authUsername').value.trim(), password: $('authPassword').value });
    projectSession.user = result.user; projectSession.project = null; connection = { configured: false };
    $('authPassword').value = ''; $('accountDialog').close(); await loadProjects(); await refreshConnection();
  } catch (error) { $('authError').textContent = error.message; $('authError').hidden = false; if (!$('accountDialog').open) toast(error.message); }
  finally { $('authSubmit').disabled = false; }
};
$('logoutAccount').onclick = async () => {
  if (busy || connecting) return toast('请先结束当前操作');
  try {
    await flushProjectSave(); await api('/api/auth/logout', {});
    resetPersonalSession(); $('accountDialog').close(); toast('已退出个人账号');
  } catch (error) { toast(error.message); }
};
function resetPersonalSession() {
  clearTimeout(projectSaveTimer); projectSession.user = null; projectSession.project = null; projectSession.projects = []; projectSession.dirty = false; projectSaveError = null;
  const m = newMap(); workspace = { maps: [m], active: m.id }; selected = m.root.id; history = []; future = []; connection = { configured: false }; agentTraceMapId = null;
  for (const id of ['apiKey','skillName','skillContent','projectBrief','hubPreview']) $(id).value = '';
  renderProjects(); render(); fit(); $('saveStatus').textContent = '未登录 · 本地草稿';
  for (const id of ['projectSkillsDialog','skillDialog','skillHubDialog','settingsDialog']) if ($(id).open) $(id).close();
}
function openNewProject() {
  if (busy) return toast('请先等待或取消当前生成');
  if (!projectSession.user) return openAccount();
  $('newProjectName').value = ''; $('newProjectDialog').showModal();
}
$('newProjectBtn').onclick = openNewProject;
$('newProjectForm').onsubmit = async event => {
  event.preventDefault(); if ($('createProject').disabled) return;
  $('createProject').disabled = true;
  try { await flushProjectSave(); const created = await api('/api/projects', defaultProject($('newProjectName').value.trim())); $('newProjectDialog').close(); await loadProjects(created.id); }
  catch (error) { toast(error.message); }
  finally { $('createProject').disabled = false; }
};
$('projectSelect').onchange = async e => { try { await selectProject(e.target.value); } catch (error) { toast(error.message); renderProjects(); } };
$('saveStatus').onclick = () => { if (projectSession.project) flushProjectSave().catch(error => toast(error.message)); };
window.addEventListener('beforeunload', event => { if (projectSession.dirty || projectSavePromise) { event.preventDefault(); event.returnValue = ''; } });
function migrateSkill(pool, saved) {
  if (!saved) return;
  const builtin = DOMAIN_SKILLS.find(s => s.id === saved.id);
  const skill = builtin ? clone(builtin) : saved.id === 'custom' && validSkill(saved) ? { ...clone(saved), id: uid(), version: saved.origin?.version || 'custom', description: '' } : saved;
  if (!skill?.content || !skill.name || pool.some(s => s.content === skill.content)) return;
  if (pool.length >= 50) throw Error('项目 Skill 数量超过 50 个，请先整理');
  pool.push({ ...skill, id: pool.some(s => s.id === skill.id) ? uid() : skill.id, enabled: true });
}
function importProjectSkills(skills, legacy) {
  const pool = projectSession.project.skills;
  if (Array.isArray(skills)) for (const s of skills) {
    if (s && typeof s.name === 'string' && s.name.length <= 80 && typeof s.content === 'string' && s.content.length <= 12000 && s.content.trim()) migrateSkill(pool, s);
  }
  migrateSkill(pool, legacy);
}
$('migrateLocal').onclick = async () => {
  if (busy) return toast('请先结束当前生成');
  try {
    await flushProjectSave();
    const local = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!validWorkspace(local)) return toast('这个浏览器没有可迁移的旧导图');
    const project = defaultProject('本地导图迁移', local); project.skills = [];
    for (const m of local.maps) migrateSkill(project.skills, m.skill || { id: 'general' });
    project.brief = [...new Set(local.maps.map(m => m.brief).filter(Boolean))].join('\n\n').slice(0, 4000);
    const saved = await api('/api/projects', project); await loadProjects(saved.id); toast('旧导图及其 Skill 已迁入独立项目，本地原件仍保留');
  } catch (error) { toast(error.message); }
};
function openProjectSkills() {
  if (busy) return toast('请先等待或取消当前生成');
  const p = projectSession.project; if (!p) return openAccount();
  renderProjects();
  $('projectEditName').value = p.name; $('projectEditBrief').value = p.brief;
  renderProjectSkills(); $('projectSkillsDialog').showModal();
}
function renderProjectSkills() {
  $('projectSkillList').replaceChildren();
  const pool = projectSession.project.skills;
  $('projectSkillCount').textContent = pool.filter(s => s.enabled !== false).length + ' 个已启用 / 共 ' + pool.length + ' 个';
  if (!pool.length) { const p = document.createElement('p'); p.textContent = '还没有 Skill，添加内置方法或从 SkillHub 导入。'; $('projectSkillList').append(p); }
  for (const skill of pool) {
    const row = document.createElement('article'); row.className = 'project-skill-row';
    const label = document.createElement('label'), toggle = document.createElement('input'), name = document.createElement('span');
    toggle.type = 'checkbox'; toggle.checked = skill.enabled !== false; toggle.setAttribute('aria-label', '启用 ' + skill.name);
    name.textContent = skill.name + ' · ' + skill.version;
    toggle.onchange = () => { skill.enabled = toggle.checked; scheduleProjectSave(); renderSkillPicker(); $('projectSkillCount').textContent = pool.filter(s => s.enabled !== false).length + ' 个已启用 / 共 ' + pool.length + ' 个'; };
    label.append(toggle, name);
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = '编辑'; edit.onclick = () => editProjectSkill(skill.id);
    const remove = document.createElement('button'); remove.className = 'btn'; remove.textContent = '移除'; remove.onclick = () => {
      projectSession.project.skills = pool.filter(s => s.id !== skill.id); scheduleProjectSave(); renderProjectSkills(); renderSkillPicker();
    };
    row.append(label, edit, remove); $('projectSkillList').append(row);
  }
  $('builtinSkillList').replaceChildren();
  for (const builtin of DOMAIN_SKILLS) {
    const button = document.createElement('button'); button.className = 'btn'; button.textContent = '＋ ' + builtin.name;
    button.disabled = pool.some(s => s.content === builtin.content);
    button.onclick = () => { addProjectSkill(clone(builtin)); renderProjectSkills(); };
    $('builtinSkillList').append(button);
  }
}
function addProjectSkill(skill) {
  const p = projectSession.project; if (!p) throw Error('请先选择个人项目');
  const existing = p.skills.find(s => s.content === skill.content);
  if (existing) { existing.enabled = true; scheduleProjectSave(); return existing; }
  if (p.skills.length >= 50) throw Error('每个项目最多保存 50 个 Skill');
  const saved = { ...skill, id: uid(), version: skill.version || skill.origin?.version || 'custom', enabled: true };
  p.skills.push(saved); scheduleProjectSave(); renderSkillPicker(); return saved;
}
function editProjectSkill(id = null) {
  if ($('projectSkillsDialog').open) {
    const name = $('projectEditName').value.trim(), brief = $('projectEditBrief').value.trim();
    if (name && name.length <= 80 && brief.length <= 4000) { projectSession.project.name = name; projectSession.project.brief = brief; scheduleProjectSave(); }
  }
  skillEditingId = id;
  const skill = projectSession.project.skills.find(s => s.id === id) || DOMAIN_SKILLS[0];
  skillDraftOrigin = normalizeSkillOrigin(skill.origin); skillOptions($('skillPreset'), 'custom');
  $('skillName').value = id ? skill.name : ''; $('skillContent').value = id ? skill.content : '';
  $('projectBrief').value = projectSession.project.brief; updateSkillCount(); renderSkillOrigin();
  $('projectSkillsDialog').close(); $('skillDialog').showModal();
}
function saveProjectSkill() {
  const name = $('skillName').value.trim(), content = $('skillContent').value.trim();
  if (!name || name.length > 80 || !content || content.length > 12000) return toast('请检查 Skill 名称和正文长度');
  const p = projectSession.project, existing = p.skills.find(s => s.id === skillEditingId);
  if (existing) Object.assign(existing, { name, content, description: content.slice(0, 160), origin: normalizeSkillOrigin(skillDraftOrigin) });
  else { try { addProjectSkill({ name, content, description: content.slice(0, 160), origin: normalizeSkillOrigin(skillDraftOrigin) }); } catch (error) { return toast(error.message); } }
  scheduleProjectSave(); $('skillDialog').close(); renderSkillPicker(); openProjectSkills(); toast('已保存到当前项目 Skill 库');
}
$('projectSkillsBtn').onclick = openProjectSkills;
$('newProjectSkill').onclick = () => editProjectSkill();
$('projectSkillHub').onclick = () => openSkillHub();
$('saveProjectInfo').onclick = async () => {
  const p = projectSession.project, name = $('projectEditName').value.trim(), brief = $('projectEditBrief').value.trim();
  if (!name || name.length > 80 || brief.length > 4000) return toast('请检查项目名称及背景长度');
  p.name = name; p.brief = brief; scheduleProjectSave();
  try { await flushProjectSave(); renderProjects(); $('projectSkillsDialog').close(); toast('项目设置已保存'); } catch (error) { toast(error.message); }
};
async function initProjects() {
  try {
    const me = await api('/api/auth/me'); projectSession.ready = true; projectSession.user = me.user;
    if (me.user) await loadProjects(); else { renderProjects(); openAccount(); }
  } catch (error) { projectSession.ready = true; renderProjects(); toast('账号服务连接失败：' + error.message); }
}
initProjects();
$('mobileProjectsBtn').onclick = () => { if (projectSession.project) openProjectSkills(); else openNewProject(); };
$('mobileAccountBtn').onclick = openAccount;

$('projectManageNew').onclick = () => { $('projectSkillsDialog').close(); openNewProject(); };
$('projectManageSelect').onchange = async e => { try { await selectProject(e.target.value); $('projectSkillsDialog').close(); openProjectSkills(); } catch (error) { toast(error.message); renderProjects(); } };
