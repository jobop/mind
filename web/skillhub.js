'use strict';
let hubPage = 1, hubTotal = 0, hubKeyword = '', hubSelection = null, hubDocuments = null;
let hubController = null, hubRequestId = 0;
function hubSetBusy(busy) {
  for (const id of ['hubSearchBtn', 'hubReadBtn']) $(id).disabled = busy;
  $('hubPrev').disabled = busy || hubPage <= 1;
  $('hubNext').disabled = busy || hubPage * 8 >= hubTotal;
}
async function hubRequest(path, payload, status) {
  hubController?.abort(); hubController = new AbortController();
  const controller = hubController, id = ++hubRequestId;
  const timeout = setTimeout(() => controller.abort(), 100000);
  hubSetBusy(true); $('hubError').hidden = true; $('hubStatus').textContent = status;
  try {
    const result = await api(path, payload, { signal: controller.signal });
    if (id !== hubRequestId) return null;
    $('hubStatus').textContent = '';
    return result;
  } catch (error) {
    if (id !== hubRequestId || !$('skillHubDialog').open) return null;
    $('hubStatus').textContent = '';
    $('hubError').textContent = error.name === 'AbortError' ? '请求超时，请重试' : error.message;
    $('hubError').hidden = false;
    return null;
  } finally {
    clearTimeout(timeout);
    if (id === hubRequestId) { hubSetBusy(false); hubController = null; }
  }
}
function openSkillHub() {
  if (busy) return toast('请先等待或取消当前生成');
  if (!$('skillDialog').open) openSkillSettings();
  $('skillHubDialog').showModal();
  if (!$('hubResults').children.length) searchHub(1);
}
async function searchHub(page = 1) {
  const query = $('hubQuery').value.trim();
  $('hubDetail').hidden = true; hubSelection = null; hubDocuments = null; $('hubUseBtn').disabled = true;
  const result = await hubRequest('/api/skillhub/search?' + new URLSearchParams({ q: query, page: String(page) }), undefined, '正在搜索腾讯 SkillHub…');
  if (!result) return;
  hubKeyword = query; hubPage = result.page; hubTotal = result.total;
  $('hubResults').replaceChildren();
  if (!result.items.length) {
    const empty = document.createElement('p'); empty.className = 'dialog-desc';
    empty.textContent = '没有找到结果，试试更短的中文关键词、英文同义词或上位概念。'; $('hubResults').append(empty);
  }
  for (const skill of result.items) {
    const card = document.createElement('article'); card.className = 'hub-card';
    const title = document.createElement('h3'); title.textContent = skill.name;
    const description = document.createElement('p'); description.textContent = skill.description;
    const meta = document.createElement('div'); meta.className = 'hub-meta';
    meta.textContent = [skill.slug, skill.version, skill.author, '下载 ' + skill.downloads.toLocaleString()].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'hub-card-actions';
    const preview = document.createElement('button'); preview.className = 'btn'; preview.textContent = '查看文档 / 导入';
    preview.onclick = () => loadHubDetail(skill.slug);
    const source = document.createElement('a'); source.textContent = '原页面 ↗';
    source.href = 'https://skillhub.cn/skills/' + encodeURIComponent(skill.slug); source.target = '_blank'; source.rel = 'noopener noreferrer';
    actions.append(preview, source); card.append(title, description, meta, actions); $('hubResults').append(card);
  }
  $('hubPage').textContent = '第 ' + hubPage + ' 页 · 共 ' + hubTotal + ' 项';
  hubSetBusy(false);
}
async function loadHubDetail(slug) {
  hubSelection = null; hubDocuments = null; $('hubUseBtn').disabled = true;
  $('hubPreview').value = ''; $('hubDetail').hidden = true;
  const result = await hubRequest('/api/skillhub/detail?' + new URLSearchParams({ slug }), undefined, '正在读取版本与文件列表…');
  if (!result) return;
  hubSelection = result;
  $('hubTitle').textContent = result.name + ' @ ' + result.version;
  $('hubDescription').textContent = result.description;
  $('hubHomepage').href = 'https://skillhub.cn/skills/' + encodeURIComponent(result.slug);
  $('hubFiles').replaceChildren();
  const textFiles = result.files.filter(f => /\.(md|markdown|txt)$/i.test(f.path));
  const primary = textFiles.find(f => f.path.toUpperCase() === 'SKILL.MD') || textFiles.find(f => /(^|\/)SKILL\.MD$/i.test(f.path)) || textFiles[0];
  for (const file of textFiles) {
    const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('span');
    checkbox.type = 'checkbox'; checkbox.value = file.path; checkbox.checked = file.path === primary?.path;
    checkbox.onchange = () => { hubDocuments = null; $('hubUseBtn').disabled = true; $('hubPreview').value = ''; };
    text.textContent = file.path + ' · ' + file.size + ' B'; label.append(checkbox, text); $('hubFiles').append(label);
  }
  if (!textFiles.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '这个 Skill 没有可导入的 Markdown 或文本文件。'; $('hubFiles').append(empty); }
  const skipped = result.files.length - textFiles.length;
  if (skipped) { const note = document.createElement('div'); note.className = 'muted'; note.textContent = '另有 ' + skipped + ' 个脚本或其他文件，本应用不执行或导入它们。'; $('hubFiles').append(note); }
  $('hubReadBtn').disabled = !textFiles.length; $('hubDetail').hidden = false;
}
function combinedHubDocuments(documents) {
  return documents.map((doc, index) => index === 0 ? doc.content : '\n\n---\n\n## 参考文档：' + doc.path + '\n\n' + doc.content).join('');
}
async function readHubDocuments() {
  if (!hubSelection) return;
  const paths = [...$('hubFiles').querySelectorAll('input:checked')].map(input => input.value);
  if (!paths.length || paths.length > 4) return toast('请选择 1–4 个 Markdown 或文本文件');
  const selection = hubSelection;
  hubDocuments = null; $('hubUseBtn').disabled = true;
  const result = await hubRequest('/api/skillhub/read', { slug: selection.slug, version: selection.version, paths }, '正在读取并校验文档完整性…');
  if (!result || hubSelection !== selection) return;
  hubDocuments = result;
  const combined = combinedHubDocuments(result.documents);
  $('hubPreview').value = combined; $('hubUseBtn').disabled = false;
  $('hubStatus').textContent = '已读取 ' + result.documents.length + ' 个文件，并通过 SHA-256 校验。' + (combined.length > 12000 ? '内容较长，载入编辑器后需精简到 12000 字符以内。' : '请检查内容后载入编辑器。');
}
function useHubSkill() {
  if (!hubDocuments || !hubSelection) return;
  let content = combinedHubDocuments(hubDocuments.documents).replace(/^\uFEFF/, '').trim();
  content = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  if (!content) return toast('文档正文为空，请选择其他文件');
  $('skillPreset').value = 'custom'; $('skillName').value = hubSelection.name.slice(0, 80); $('skillContent').value = content;
  skillDraftOrigin = normalizeSkillOrigin({ provider: 'skillhub', slug: hubDocuments.slug, version: hubDocuments.version, files: hubDocuments.documents.map(doc => ({ path: doc.path, sha256: doc.sha256 })) });
  updateSkillCount(); renderSkillOrigin(); $('skillHubDialog').close();
  toast(content.length > 12000 ? '已载入原文，请精简到 12000 字符以内后应用' : '已载入，请检查后点击「应用到当前导图」');
}
$('openSkillHub').onclick = openSkillHub;
$('hubSearchForm').onsubmit = e => { e.preventDefault(); searchHub(1); };
$('hubPrev').onclick = () => { $('hubQuery').value = hubKeyword; searchHub(hubPage - 1); };
$('hubNext').onclick = () => { $('hubQuery').value = hubKeyword; searchHub(hubPage + 1); };
$('hubReadBtn').onclick = readHubDocuments;
$('hubUseBtn').onclick = useHubSkill;
$('skillHubDialog').addEventListener('close', () => { hubRequestId++; hubController?.abort(); hubController = null; hubSetBusy(false); });
