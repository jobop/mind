// Tencent SkillHub public Open API. No model credentials are sent to this service.
const HUB_ORIGIN = 'https://api.skillhub.cn';
function hubSlug(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value)) throw new AppError('Skill 标识格式不正确');
  return value;
}
function hubVersion(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(value)) throw new AppError('Skill 版本格式不正确');
  return value;
}
function hubPath(value) {
  if (typeof value !== 'string' || value.length > 240 || value.startsWith('/') || /[\\\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..') || !/\.(md|markdown|txt)$/i.test(value)) throw new AppError('只能读取 Skill 内的 Markdown 或文本文件');
  return value;
}
async function hubFetch(path, env, request, { file = false, limit = 600000 } = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 20000);
  const id = request.headers.get('oai-authenticated-user-id') || request.headers.get('CF-Connecting-IP') || 'local';
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(id));
  const user = [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    let url = new URL(path, HUB_ORIGIN), response;
    for (let redirects = 0; redirects < 4; redirects++) {
      const h = { Accept: file ? 'text/markdown,text/plain' : 'application/json' };
      if (url.origin === HUB_ORIGIN) {
        h['X-Client-User-Id'] = user;
        if (env.SKILLHUB_API_KEY) h['X-API-Key'] = env.SKILLHUB_API_KEY;
      }
      response = await fetch(url, { headers: h, redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('Location'); await response.body?.cancel();
      if (!file || !location || redirects === 3) throw new AppError('SkillHub 文件跳转异常', 502, 'SKILLHUB_UNAVAILABLE');
      const next = new URL(location, url);
      const host = next.hostname.toLowerCase();
      if (next.protocol !== 'https:' || next.username || next.password || next.port && next.port !== '443' || !(host === 'api.skillhub.cn' || host.endsWith('.myqcloud.com') || host.endsWith('.skillhub.cn'))) throw new AppError('SkillHub 返回了不支持的文件存储地址', 502, 'SKILLHUB_UNAVAILABLE');
      url = next;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new AppError('Skill 或指定版本文件不存在，可能已下架', 404, 'SKILLHUB_NOT_FOUND');
      if ([401, 403].includes(response.status)) throw new AppError('SkillHub 拒绝访问，该内容可能需要权限或服务端 API Key', 502, 'SKILLHUB_ACCESS');
      if (response.status === 429) throw new AppError('SkillHub 请求过于频繁，请稍后再试', 429, 'SKILLHUB_RATE_LIMITED');
      throw new AppError('SkillHub 暂时无法响应，请稍后重试', 502, 'SKILLHUB_UNAVAILABLE');
    }
    if (Number(response.headers.get('Content-Length') || 0) > limit) { await response.body?.cancel(); throw new AppError('SkillHub 内容过大，请选取更精简的文档', 413); }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AppError('SkillHub 内容过大，请选取更精简的文档', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, text: decoder.decode(bytes) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(controller.signal.aborted ? 'SkillHub 请求超时或已取消，请重试' : '无法连接 SkillHub，请检查网络后重试', 502, 'SKILLHUB_UNAVAILABLE');
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); }
}
async function hubJSON(path, env, request) {
  const data = await hubFetch(path, env, request);
  try { return JSON.parse(data.text); } catch { throw new AppError('SkillHub 返回格式异常', 502, 'SKILLHUB_UNAVAILABLE'); }
}
function hubFileList(data) {
  if (!Array.isArray(data.files) || data.files.length > 3000) throw new AppError('SkillHub 文件列表格式异常', 502, 'SKILLHUB_UNAVAILABLE');
  return data.files.filter(f => typeof f.path === 'string').map(f => ({ path: f.path, size: Number(f.size) || 0, sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : '' }));
}
async function skillHubRoute(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET') {
    if (request.headers.get('X-Branch-Request') !== '1') throw new AppError('请求来源验证失败', 403);
  } else checkOrigin(request);
  if (path === '/api/skillhub/search' && request.method === 'GET') {
    const keyword = asText(url.searchParams.get('q') || '', '搜索词', 120, false);
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new AppError('页码格式不正确');
    const query = new URLSearchParams({ keyword, sortBy: keyword ? 'score' : 'downloads', order: 'desc', page: String(page), pageSize: '8' });
    const data = await hubJSON('/api/skills?' + query, env, request);
    if (data.code !== 0 || !Array.isArray(data.data?.skills)) throw new AppError('SkillHub 搜索结果格式异常', 502, 'SKILLHUB_UNAVAILABLE');
    const items = data.data.skills.filter(s => typeof s.slug === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(s.slug)).slice(0, 8).map(s => ({
      slug: s.slug, name: String(s.name || s.slug).slice(0, 160), description: String(s.description_zh || s.description || '').slice(0, 1800),
      version: String(s.version || '').slice(0, 80), author: String(s.ownerName || '').slice(0, 120), downloads: Number(s.downloads) || 0,
      source: String(s.source || ''), category: String(s.category || ''), url: 'https://skillhub.cn/skills/' + encodeURIComponent(s.slug),
    }));
    return json({ items, total: Number(data.data.total) || 0, page, pageSize: 8 });
  }
  if (path === '/api/skillhub/detail' && request.method === 'GET') {
    const slug = hubSlug(url.searchParams.get('slug'));
    const detail = await hubJSON('/api/v1/skills/' + encodeURIComponent(slug), env, request);
    const version = hubVersion(detail.latestVersion?.version);
    const data = await hubJSON('/api/v1/skills/' + encodeURIComponent(slug) + '/files?version=' + encodeURIComponent(version), env, request);
    const files = hubFileList(data);
    return json({ slug, version: hubVersion(data.version || version), name: String(detail.skill?.displayName || slug).slice(0, 80), description: String(detail.skill?.summary_zh || detail.skill?.summary || '').slice(0, 2000), url: 'https://skillhub.cn/skills/' + encodeURIComponent(slug), files });
  }
  if (path === '/api/skillhub/read' && request.method === 'POST') {
    const input = await body(request), slug = hubSlug(input.slug), version = hubVersion(input.version);
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 4 || new Set(input.paths).size !== input.paths.length) throw new AppError('请选择 1–4 个 Markdown 或文本文件');
    const paths = input.paths.map(hubPath);
    const data = await hubJSON('/api/v1/skills/' + encodeURIComponent(slug) + '/files?version=' + encodeURIComponent(version), env, request);
    const files = hubFileList(data), selected = paths.map(path => files.find(f => f.path === path));
    if (selected.some(f => !f)) throw new AppError('所选文件不属于该 Skill 版本');
    if (selected.some(f => f.size > 64000)) throw new AppError('所选文档超过 64KB，请选择更精简的参考文件', 413);
    const documents = [];
    for (const file of selected) {
      const result = await hubFetch('/api/v1/skills/' + encodeURIComponent(slug) + '/file?' + new URLSearchParams({ path: file.path, version }), env, request, { file: true, limit: 64000 });
      const hash = await crypto.subtle.digest('SHA-256', result.bytes);
      const sha256 = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || sha256 !== file.sha256) throw new AppError('SkillHub 文件完整性校验失败，请重新获取', 502, 'SKILLHUB_INTEGRITY');
      if (result.text.includes('\u0000') || /^\s*<!doctype html|^\s*<html/i.test(result.text)) throw new AppError('SkillHub 返回了非文本内容', 502);
      documents.push({ path: file.path, content: result.text, sha256 });
    }
    return json({ slug, version, documents, url: 'https://skillhub.cn/skills/' + encodeURIComponent(slug) });
  }
  return json({ error: '接口不存在' }, 404);
}
