import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../dist/server/index.js';
const origin = 'https://branch.testing.com';
const env = { SKILLHUB_API_KEY: 'test-team-key' };
const source = '# 产品方法\n先定义决策，再检查证据。';
const hash = createHash('sha256').update(source).digest('hex');
const files = { version: '1.0.0', files: [{ path: 'SKILL.md', size: Buffer.byteLength(source), sha256: hash }, { path: 'run.sh', size: 10, sha256: hash }] };
const detail = { skill: { displayName: '产品方法', summary_zh: '从场景与证据展开' }, latestVersion: { version: '1.0.0' } };
async function call(path, data, headers = {}) {
  const request = new Request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Branch-Request': '1', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  return worker.fetch(request, env);
}
test('search uses the official API and only returns normalized fields', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.skillhub.cn');
    assert.equal(new URL(url).pathname, '/api/skills');
    assert.equal(new URL(url).searchParams.get('keyword'), '产品');
    assert.equal(options.headers['X-API-Key'], 'test-team-key');
    assert.equal(options.headers.Authorization, undefined);
    assert.match(options.headers['X-Client-User-Id'], /^[a-f0-9]{16}$/);
    return Response.json({ code: 0, data: { total: 1, skills: [{ slug: 'product-method', name: '<script>alert(1)</script>', description_zh: '方法', homepage: 'https://evil.com', secretField: 'ignored' }] } });
  };
  try {
    const response = await call('/api/skillhub/search?q=' + encodeURIComponent('产品'));
    const result = await response.json(); assert.equal(response.status, 200);
    assert.equal(result.items[0].url, 'https://skillhub.cn/skills/product-method');
    assert.equal(result.items[0].secretField, undefined);
    assert.equal((await call('/api/skillhub/search?page=-1')).status, 400);
  } finally { globalThis.fetch = saved; }
});
test('details pin the file listing to an explicit version', async () => {
  const saved = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    const u = new URL(url); calls.push(u);
    return Response.json(u.pathname.endsWith('/files') ? files : detail);
  };
  try {
    const response = await call('/api/skillhub/detail?slug=product-method'), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.version, '1.0.0');
    assert.equal(calls[1].searchParams.get('version'), '1.0.0');
    assert.equal(result.files.length, 2);
    assert.equal((await call('/api/skillhub/detail?slug=..%2Fsecret')).status, 400);
  } finally { globalThis.fetch = saved; }
});
test('document reads verify the hash and do not forward the team key to object storage', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/files')) return Response.json(files);
    if (u.hostname === 'api.skillhub.cn') return new Response(null, { status: 302, headers: { Location: 'https://skillhub-123.cos.accelerate.myqcloud.com/skill.md' } });
    assert.equal(options.headers['X-API-Key'], undefined);
    assert.equal(options.headers['X-Client-User-Id'], undefined);
    return new Response(source);
  };
  try {
    const response = await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['SKILL.md'] });
    const result = await response.json(); assert.equal(response.status, 200);
    assert.equal(result.documents[0].sha256, hash); assert.equal(result.documents[0].content, source);
    assert.equal((await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['run.sh'] })).status, 400);
    assert.equal((await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['../SKILL.md'] })).status, 400);
  } finally { globalThis.fetch = saved; }
});
test('rejects tampered files, untrusted redirects and unknown file paths', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async url => new URL(url).pathname.endsWith('/files') ? Response.json(files) : new Response('tampered');
  try {
    let response = await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['SKILL.md'] });
    assert.equal(response.status, 502); assert.equal((await response.json()).code, 'SKILLHUB_INTEGRITY');
    assert.equal((await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['not-listed.md'] })).status, 400);
    globalThis.fetch = async url => new URL(url).pathname.endsWith('/files') ? Response.json(files) : new Response(null, { status: 302, headers: { Location: 'https://evil.com/file.md' } });
    response = await call('/api/skillhub/read', { slug: 'product-method', version: '1.0.0', paths: ['SKILL.md'] });
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = saved; }
});
test('upstream failures are readable errors and cross-origin reads are rejected', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('private provider error', { status: 429 });
  try {
    const response = await call('/api/skillhub/search?q=product');
    assert.equal(response.status, 429); assert.doesNotMatch(await response.text(), /private provider error/);
    assert.equal((await call('/api/skillhub/search', undefined, { 'X-Branch-Request': '' })).status, 403);
    assert.equal((await call('/api/skillhub/read', { slug: 'x' }, { Origin: 'https://evil.com' })).status, 403);
  } finally { globalThis.fetch = saved; }
});
