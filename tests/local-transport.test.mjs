import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLocalServer } from '../scripts/local-server.mjs';
import { localEnvironment } from '../scripts/local-server.mjs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { runPiAgent } from '../runtime/pi-agent.mjs';
import { testPiConnection } from '../runtime/pi-model.mjs';
import { sseMessage } from './fixtures/pi-sse.mjs';

test('local server streams progress before completion and runs the actual Pi SDK with encrypted browser credentials', async () => {
  const env = { CONNECTION_ENCRYPTION_KEY: 'test-key-with-more-than-thirty-two-characters', AGENT_RUNNER: runPiAgent, AGENT_TEST: testPiConnection };
  const server = createLocalServer(env);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const nativeFetch = globalThis.fetch; let releaseModel, modelCalls = 0;
  const children = ['水量如何估算？','停水如何处理？','异常如何发现？'].map(title => ({ title, note: '【决策意义】这一问题决定灌溉系统的容量与无人值守边界，应结合具体作物和季节明确需求。【验证方式】先做小范围试点，记录一周使用情况，以现场数据确定参数并保留待验证假设。', sourceIds: [] }));
  globalThis.fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(origin)) return nativeFetch(input, options);
    const data = JSON.parse(options.body);
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer local-test-key');
    modelCalls++;
    if (data.tool_choice?.function?.name === 'connection_check') return sseMessage([{ name: 'connection_check', args: { ok: true } }]);
    if (modelCalls === 2) return new Promise(resolve => { releaseModel = () => resolve(sseMessage([
      { name: 'plan_work', args: { steps: ['读取节点与方法', '校验并提交分支'] } },
      { name: 'read_node_context', args: {} }, { name: 'read_skill', args: {} },
    ])); });
    if (modelCalls === 3) return sseMessage([{ name: 'submit_branches', args: { children } }]);
    throw Error('Unexpected provider request');
  };
  try {
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Branch-Request': '1' };
    const connect = await nativeFetch(origin + '/api/connection', { method: 'POST', headers, body: JSON.stringify({ base: 'https://api.vendor.com/v1', model: 'tool-capable-model', key: 'local-test-key' }) });
    assert.equal(connect.status, 200, await connect.clone().text());
    const cookie = connect.headers.get('Set-Cookie');
    assert.match(cookie, /^branch-local-connection=/); assert.match(cookie, /HttpOnly/); assert.doesNotMatch(cookie, /local-test-key/);
    const response = await nativeFetch(origin + '/api/generate', {
      method: 'POST', headers: { ...headers, Cookie: cookie.split(';')[0], Accept: 'application/x-ndjson' },
      body: JSON.stringify({ topic: '屋顶菜园', title: '灌溉', mode: 'questions', quantity: 3, existing: [], ancestors: [] }),
    });
    assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /x-ndjson/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const first = await reader.read(); let text = decoder.decode(first.value);
    assert.match(text, /"connected"/); assert.doesNotMatch(text, /"type":"result"/);
    assert.equal(typeof releaseModel, 'function'); releaseModel();
    while (true) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); }
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.type === 'tool_start' && e.tool === 'read_skill'));
    const result = events.find(e => e.type === 'result').result;
    assert.equal(result.agent.framework, 'pi-agent-core'); assert.equal(result.agent.modelCalls, 2);
    assert.equal(result.children.length, 3); assert.equal(modelCalls, 3);
  } finally {
    globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
test('HTTPS reverse proxy preserves secure cookies, validates origin and reports the deployed SHA', async () => {
  const sha = 'a'.repeat(40), publicOrigin = 'https://mind.made-world.link';
  const env = {
    PUBLIC_ORIGIN: publicOrigin, RELEASE_SHA: sha, CONNECTION_ENCRYPTION_KEY: 'test-production-key-more-than-32-characters',
    AGENT_RUNNER: runPiAgent, AGENT_TEST: async connection => { assert.equal(connection.key, 'test-production-api-key'); },
  };
  const server = createLocalServer(env); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const proxyRequest = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key,value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const headers = { Host: 'mind.made-world.link', Origin: publicOrigin, 'Content-Type': 'application/json', 'X-Branch-Request': '1' };
  try {
    assert.equal((await fetch(base + '/healthz')).status, 403);
    const health = await (await proxyRequest(base + '/healthz', { headers })).json();
    assert.equal(health.release, sha); assert.equal(health.agent, true);
    const connect = await proxyRequest(base + '/api/connection', { method: 'POST', headers, body: JSON.stringify({ base: 'https://api.vendor.com/v1', model: 'model', key: 'test-production-api-key' }) });
    assert.equal(connect.status, 200);
    const cookie = connect.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-branch-connection=/); assert.match(cookie, /; Secure;/); assert.match(cookie, /HttpOnly/);
    const config = await (await proxyRequest(base + '/api/config', { headers: { ...headers, Cookie: cookie.split(';')[0] } })).json();
    assert.equal(config.configured, true);
    const invalid = await proxyRequest(base + '/api/connection', { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.com', Cookie: cookie.split(';')[0] } });
    assert.equal(invalid.status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('DATA_DIR keeps the encryption key stable across application releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mind-data-test-'));
  const old = { DATA_DIR: process.env.DATA_DIR, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN, RELEASE_SHA: process.env.RELEASE_SHA };
  try {
    process.env.DATA_DIR = directory; process.env.PUBLIC_ORIGIN = 'https://mind.made-world.link'; process.env.RELEASE_SHA = 'a'.repeat(40);
    const first = await localEnvironment(); process.env.RELEASE_SHA = 'b'.repeat(40); const second = await localEnvironment();
    assert.equal(first.CONNECTION_ENCRYPTION_KEY, second.CONNECTION_ENCRYPTION_KEY);
    assert.equal(second.RELEASE_SHA, 'b'.repeat(40));
    assert.equal((await stat(join(directory, 'encryption-key'))).mode & 0o777, 0o600);
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('public source download serves only the fixed archive and checksum with GET and HEAD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mind-download-test-'));
  const { writeFile } = await import('node:fs/promises');
  const bytes = Buffer.from('PK\x03\x04source-archive-fixture');
  await writeFile(join(directory, 'mind-source.zip'), bytes);
  await writeFile(join(directory, 'mind-source.sha256'), 'test-checksum  mind-source.zip\n');
  const server = createLocalServer({ SOURCE_DOWNLOAD_DIR: directory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(origin + '/downloads/mind-source.zip');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/zip');
    assert.match(response.headers.get('Content-Disposition'), /attachment; filename="mind-source.zip"/);
    assert.equal(response.headers.get('Content-Length'), String(bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const head = await fetch(origin + '/downloads/mind-source.zip', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(origin + '/downloads/mind-source.zip', { method: 'POST' })).status, 405);
    assert.match(await (await fetch(origin + '/downloads/mind-source.sha256')).text(), /test-checksum/);
    for (const path of ['/downloads/encryption-key', '/downloads/.env', '/toString']) {
      const unknown = await fetch(origin + path);
      assert.notEqual(unknown.status, 500); assert.doesNotMatch(await unknown.text(), /source-archive-fixture|test-checksum/);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
