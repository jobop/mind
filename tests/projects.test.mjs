import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from '../runtime/projects.mjs';
import worker from '../dist/server/index.js';
const origin = 'https://mind.example.org';
const projectData = (name, marker = name) => ({ name, brief: marker + '背景', skills: [{ id: marker, name: marker + '方法', version: '1.0', description: marker + '说明', content: marker + '方法正文' }], workspace: { maps: [{ id: 'map', title: marker, root: { id: 'root', title: marker, note: '', children: [] } }], active: 'map' } });
function client(service) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(path, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
      const response = await service.handle(new Request(origin + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Branch-Request': '1', Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }));
      if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
      return { status: response.status, headers: response.headers, data: await response.json() };
    },
    async register(username) { const response = await this.request('/api/auth/register', { username, password: 'test-password-2026' }); assert.equal(response.status, 200); return response; },
  };
}
test('personal projects enforce ownership for list, read, update and deletion with optimistic saves', async () => {
  const service = new ProjectService(':memory:'), a = client(service), b = client(service);
  try {
    await a.register('alice'); await b.register('bob');
    const p = await a.request('/api/projects', projectData('甲项目','alpha'));
    const q = await a.request('/api/projects', projectData('乙项目','beta'));
    assert.equal(p.status, 201); assert.equal(q.status, 201);
    assert.equal((await a.request('/api/projects')).data.projects.length, 2);
    assert.deepEqual((await b.request('/api/projects')).data.projects, []);
    for (const method of ['GET','PUT','DELETE']) assert.equal((await b.request('/api/projects/' + p.data.id, method === 'PUT' ? p.data : undefined, method)).status, 404);
    const updated = await a.request('/api/projects/' + p.data.id, { ...p.data, name: '重命名' }, 'PUT');
    assert.equal(updated.status, 200); assert.equal(updated.data.revision, 2);
    assert.equal((await a.request('/api/projects/' + p.data.id, p.data, 'PUT')).status, 409);
    assert.equal((await a.request('/api/projects/' + q.data.id)).data.skills[0].id, 'beta');
  } finally { service.close(); }
});
test('sessions survive service restart, store hashed credentials, reject CSRF and revoke on logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mind-projects-')), path = join(directory, 'projects.sqlite');
  let service = new ProjectService(path);
  try {
    const a = client(service), registered = await a.register('persistent');
    assert.match(registered.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Secure/);
    const cookie = a.cookie;
    const created = await a.request('/api/projects', projectData('持久项目'));
    const row = service.db.prepare('SELECT password FROM users').get();
    assert.doesNotMatch(row.password, /test-password/);
    assert.notEqual(service.db.prepare('SELECT token FROM sessions').get().token, cookie.split('=')[1]);
    service.close(); service = new ProjectService(path);
    const response = await service.handle(new Request(origin + '/api/projects/' + created.data.id, { headers: { Cookie: cookie } }));
    assert.equal(response.status, 200); assert.equal((await response.json()).name, '持久项目');
    assert.equal((await service.handle(new Request(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.org', 'X-Branch-Request': '1' } }))).status, 403);
    const logout = await service.handle(new Request(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Branch-Request': '1' } })); assert.equal(logout.status, 200);
    assert.equal((await service.handle(new Request(origin + '/api/projects', { headers: { Cookie: cookie } }))).status, 401);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('authentication rejects invalid passwords and project validation rejects duplicate or oversized skills', async () => {
  const service = new ProjectService(':memory:'), a = client(service);
  try {
    assert.equal((await a.request('/api/auth/register', { username: 'bad', password: 'short' })).status, 400);
    await a.register('valid-user');
    assert.equal((await a.request('/api/auth/login', { username: 'valid-user', password: 'wrong-password' })).status, 401);
    const p = projectData('验证'); p.skills.push(p.skills[0]);
    assert.equal((await a.request('/api/projects', p)).status, 400);
    p.skills = [{ ...p.skills[0], content: 'x'.repeat(12001) }];
    assert.equal((await a.request('/api/projects', p)).status, 400);
  } finally { service.close(); }
});
test('generation uses only the authenticated project library and binds model credentials to the account', async () => {
  const service = new ProjectService(':memory:'), a = client(service), b = client(service);
  let received;
  const env = { PROJECT_SERVICE: service, CONNECTION_ENCRYPTION_KEY: 'test-key-longer-than-thirty-two-characters', AGENT_TEST: async () => {}, AGENT_RUNNER: async args => {
    received = args; return { children: ['一','二','三'].map(title => ({ title, note: '方法结果' })), model: 'model', agent: { framework: 'pi-agent-core' } };
  } };
  try {
    await a.register('agent-owner'); await b.register('agent-other');
    const p = (await a.request('/api/projects', projectData('项目一','one'))).data;
    const q = (await a.request('/api/projects', projectData('项目二','two'))).data;
    const call = (path, input, cookie) => worker.fetch(new Request(origin + path, { method: input ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin, 'X-Branch-Request': '1' }, body: input ? JSON.stringify(input) : undefined }), env);
    assert.equal((await call('/api/connection', { base: 'https://api.vendor.com/v1', model: 'model', key: 'test-not-real-key' }, '')).status, 401);
    const connected = await call('/api/connection', { base: 'https://api.vendor.com/v1', model: 'model', key: 'test-not-real-key' }, a.cookie);
    assert.equal(connected.status, 200);
    const connectionCookie = connected.headers.get('Set-Cookie').split(';')[0], cookies = a.cookie + '; ' + connectionCookie;
    const configB = await (await call('/api/config', undefined, b.cookie + '; ' + connectionCookie)).json();
    assert.equal(configB.configured, false);
    const input = { projectId: p.id, topic: '主题', title: '节点', brief: 'forged-brief', skill: { id: 'custom', name: 'forged', content: 'forged-secret' }, mode: 'questions', quantity: 3, existing: [], ancestors: [] };
    assert.equal((await call('/api/generate', input, cookies)).status, 200);
    assert.deepEqual(received.skills.map(s => s.id), ['one']); assert.equal(received.job.brief, 'one背景');
    assert.equal(received.job.project.id, p.id); assert.doesNotMatch(JSON.stringify(received.skills), /two|forged/);
    const bConnected = await call('/api/connection', { base: 'https://api.vendor.com/v1', model: 'model', key: 'other-test-key' }, b.cookie);
    const denied = await call('/api/generate', { ...input, projectId: q.id }, b.cookie + '; ' + bConnected.headers.get('Set-Cookie').split(';')[0]);
    assert.equal(denied.status, 404);
  } finally { service.close(); }
});
