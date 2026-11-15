import { validateNodeResources } from './resources.mjs';
import { buildMapContext } from './map-context.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive), SESSION_MS = 30 * 86400000, MAX_BYTES = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export class ProjectError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new ProjectError(message, status, code); };
const text = (value, max, name, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(name + '格式不正确');
  return value.trim();
};
export function validateProject(input) {
  const name = text(input.name, 80, '项目名称'), brief = text(input.brief ?? '', 4000, '项目背景', true);
  if (!Array.isArray(input.skills) || input.skills.length > 50) fail('每个项目最多保存 50 个 Skill');
  const skillIds = new Set();
  const skills = input.skills.map(s => {
    if (!s || typeof s !== 'object') fail('Skill 格式不正确');
    const id = text(s.id, 80, 'Skill ID');
    if (skillIds.has(id)) fail('Skill ID 不能重复'); skillIds.add(id);
    const origin = s.origin;
    return { id, name: text(s.name, 80, 'Skill 名称'), description: text(s.description ?? '', 500, 'Skill 描述', true),
      content: text(s.content, 12000, 'Skill 正文'), version: text(s.version || 'custom', 80, 'Skill 版本'), enabled: s.enabled !== false,
      origin: origin?.provider === 'skillhub' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(origin.slug) ? { provider: 'skillhub', slug: origin.slug, version: text(origin.version, 80, '来源版本'), modified: origin.modified === true, files: Array.isArray(origin.files) ? origin.files.filter(f => f && typeof f.path === 'string' && f.path.length <= 240 && /^[a-f0-9]{64}$/.test(f.sha256)).slice(0, 4).map(f => ({ path: f.path, sha256: f.sha256 })) : [] } : null };
  });
  const workspace = input.workspace;
  if (!workspace || !Array.isArray(workspace.maps) || !workspace.maps.length || workspace.maps.length > 100) fail('项目需包含 1–100 张导图');
  const mapIds = new Set();
  for (const map of workspace.maps) {
    if (!map || typeof map !== 'object') fail('导图格式不正确');
    text(map.id, 80, '导图 ID'); text(map.title, 80, '导图名称');
    if (mapIds.has(map.id)) fail('导图 ID 不能重复'); mapIds.add(map.id);
    const seen = new Set();
    function node(n, depth = 0) {
      if (!n || depth > 20 || !Array.isArray(n.children) || n.children.length > 200) fail('节点结构或层级不正确');
      text(n.id, 80, '节点 ID'); text(n.title, 80, '节点名称'); text(n.note ?? '', 3000, '节点备注', true);
      if (seen.has(n.id) || seen.size >= 2000) fail('节点 ID 重复或超过 2000 个节点'); seen.add(n.id);
      if(n.resources !== undefined) n.resources = validateNodeResources(n.resources);
      n.children.forEach(c => node(c, depth + 1));
    }
    node(map.root);
  }
  if (!mapIds.has(workspace.active)) fail('当前导图不存在');
  return { name, brief, skills, workspace };
}
async function readBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('需要 JSON 请求', 415);
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) fail('项目超过 8MB，请拆分项目', 413);
  const reader = request.body?.getReader(); if (!reader) fail('请求内容为空');
  let size = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) { await reader.cancel(); fail('项目超过 8MB，请拆分项目', 413); } chunks.push(value); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); return body; }
  catch { fail('JSON 格式不正确'); }
}
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
export class ProjectService {
  constructor(path) {
    this.db = new DatabaseSync(path); this.attempts = new Map(); this.pending = 0;
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_owner ON projects(owner_id);`);
  }
  close() { this.db.close(); }
  mapContext(project,mapId,nodeId) { return buildMapContext(project,mapId,nodeId); }
  cookieName(request) { return new URL(request.url).protocol === 'https:' ? '__Host-mind-session' : 'mind-local-session'; }
  token(request) { const prefix = this.cookieName(request) + '='; return (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(prefix))?.slice(prefix.length); }
  user(request, required = true) {
    const token = this.token(request);
    const user = token && /^[a-f0-9]{64}$/.test(token) ? this.db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires>?').get(hash(token), Date.now()) : null;
    if (!user && required) fail('请先登录个人账号', 401, 'AUTH_REQUIRED');
    return user || null;
  }
  get(request, id) {
    const user = this.user(request);
    const row = typeof id === 'string' ? this.db.prepare('SELECT id,data,revision,updated FROM projects WHERE id=? AND owner_id=?').get(id, user.id) : null;
    if (!row) fail('项目不存在或无权访问', 404, 'PROJECT_NOT_FOUND');
    return { id: row.id, ...JSON.parse(row.data), revision: row.revision, updated: row.updated };
  }
  async handle(request) {
    const path = new URL(request.url).pathname, method = request.method;
    try {
      if (!['GET','HEAD'].includes(method) && (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('X-Branch-Request') !== '1')) fail('请求来源验证失败', 403, 'INVALID_ORIGIN');
      if (path === '/api/auth/me' && method === 'GET') return json({ user: this.user(request, false), projectsEnabled: true });
      const cookie = value => this.cookieName(request) + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
      if (path === '/api/auth/logout' && method === 'POST') {
        const token = this.token(request); if (token) this.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
        return json({ user: null }, 200, { 'Set-Cookie': cookie('') + '; Max-Age=0' });
      }
      if (['/api/auth/register','/api/auth/login'].includes(path) && method === 'POST') {
        const input = await readBody(request), username = text(input.username, 40, '用户名').normalize('NFKC').toLowerCase();
        if (!/^[\p{L}\p{N}_-]{3,40}$/u.test(username)) fail('用户名需为 3–40 位文字、数字、下划线或短横线');
        const password = input.password;
        if (typeof password !== 'string' || password.length < 10 || password.length > 128) fail('密码需为 10–128 位');
        const now = Date.now(), ip = request.headers.get('CF-Connecting-IP') || 'local';
        for (const [key, item] of this.attempts) if (now - item.start > 900000) this.attempts.delete(key);
        for (const key of ['ip:' + ip, 'name:' + username]) {
          const attempt = this.attempts.get(key) || { start: now, count: 0 }; this.attempts.set(key, attempt);
          if (++attempt.count > (key.startsWith('ip:') ? 30 : 10)) fail('尝试次数较多，请 15 分钟后再试', 429, 'RATE_LIMITED');
        }
        if (this.pending >= 4) fail('登录请求繁忙，请稍后重试', 429);
        let user; this.pending++;
        try {
          if (path.endsWith('/register')) {
            const salt = randomBytes(16).toString('hex'), derived = await scrypt(password, salt, 64);
            const id = randomUUID();
            try { this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, username, salt + ':' + derived.toString('hex'), now); }
            catch (error) { if (error.message.includes('UNIQUE')) fail('用户名已使用', 409); throw error; }
            user = { id, username };
          } else {
            const row = this.db.prepare('SELECT id,username,password FROM users WHERE username=?').get(username);
            const [salt, expected] = (row?.password || 'dummy-salt:' + '0'.repeat(128)).split(':');
            const derived = await scrypt(password, salt, 64);
            if (!row || !timingSafeEqual(derived, Buffer.from(expected, 'hex'))) fail('用户名或密码不正确', 401, 'INVALID_CREDENTIAL');
            user = { id: row.id, username: row.username };
          }
        } finally { this.pending--; }
        this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
        const token = randomBytes(32).toString('hex');
        this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, now + SESSION_MS);
        return json({ user }, 200, { 'Set-Cookie': cookie(token) + '; Max-Age=' + SESSION_MS / 1000 });
      }
      const user = this.user(request);
      if (path === '/api/projects' && method === 'GET') {
        const projects = this.db.prepare('SELECT id,data,revision,updated FROM projects WHERE owner_id=? ORDER BY updated DESC').all(user.id).map(row => {
          const p = JSON.parse(row.data); return { id: row.id, name: p.name, revision: row.revision, updated: row.updated, skillCount: p.skills.length, mapCount: p.workspace.maps.length };
        });
        return json({ projects });
      }
      if (path === '/api/projects' && method === 'POST') {
        if (this.db.prepare('SELECT count(*) AS n FROM projects WHERE owner_id=?').get(user.id).n >= 50) fail('每人最多创建 50 个项目');
        const data = validateProject(await readBody(request)), id = randomUUID(), now = Date.now();
        this.db.prepare('INSERT INTO projects VALUES(?,?,?,1,?)').run(id, user.id, JSON.stringify(data), now);
        return json(this.get(request, id), 201);
      }
      const match = path.match(/^\/api\/projects\/([a-f0-9-]{36})$/);
      if (match) {
        const current = this.get(request, match[1]);
        if (method === 'GET') return json(current);
        if (method === 'PUT') {
          const input = await readBody(request), data = validateProject(input);
          const result = this.db.prepare('UPDATE projects SET data=?,revision=revision+1,updated=? WHERE id=? AND owner_id=? AND revision=?').run(JSON.stringify(data), Date.now(), current.id, user.id, Number(input.revision));
          if (!result.changes) fail('项目已在其他页面修改，请导出当前导图后重新载入', 409, 'REVISION_CONFLICT');
          return json(this.get(request, current.id));
        }
        if (method === 'DELETE') {
          this.db.prepare('DELETE FROM projects WHERE id=? AND owner_id=?').run(current.id, user.id); return json({ deleted: true });
        }
      }
      return json({ error: '接口不存在' }, 404);
    } catch (error) {
      if (error instanceof ProjectError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: '项目服务暂时不可用', code: 'INTERNAL_ERROR' }, 500);
    }
  }
}
