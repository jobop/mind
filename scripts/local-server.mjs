import { ResourceService } from '../runtime/resources.mjs';
import { platformE2BKey } from '../runtime/platform-config.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { GenerationJobs } from '../runtime/generation-jobs.mjs';
import { ProjectService } from '../runtime/projects.mjs';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import worker, { skillHubBundle } from '../dist/server/index.js';
import { prepareSkillSnapshot } from '../runtime/skill-snapshot.mjs';
import { runE2BAgent } from '../runtime/e2b-runner.mjs';
import { testPiConnection } from '../runtime/pi-model.mjs';

export async function localEnvironment() {
  const dataDir = process.env.DATA_DIR ? pathToFileURL(resolve(process.env.DATA_DIR) + '/') : new URL('../.branch-data/', import.meta.url);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const keyFile = new URL('encryption-key', dataDir);
  let secret;
  try { secret = await readFile(keyFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(48).toString('base64url');
    try { await writeFile(keyFile, secret, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; secret = await readFile(keyFile, 'utf8'); }
  }
  let release = process.env.RELEASE_SHA || '';
  if (!release) { try { release = (await readFile(new URL('../RELEASE', import.meta.url), 'utf8')).trim(); } catch {} }
  const projects = new ProjectService(fileURLToPath(new URL('projects.sqlite', dataDir)));
  const resources = new ResourceService(projects, secret);
  const e2bKey = platformE2BKey(process.env.E2B_API_KEY);
  const sandboxConfigured = e2bKey.startsWith('e2b_');
  const agentRunner = async args => {
    if (!sandboxConfigured) throw Object.assign(new Error('平台尚未配置 E2B 沙箱，请维护者配置 E2B_API_KEY'), { code: 'AGENT_SANDBOX_NOT_CONFIGURED' });
    const preparation = AbortSignal.any([args.signal, AbortSignal.timeout(90000)]);
    const prepared = await prepareSkillSnapshot({ skills: args.skills, projectId: args.job.project.id, cacheDirectory: fileURLToPath(new URL('skill-cache/', dataDir)), signal: preparation, emit: args.emit,
      loadBundle: source => skillHubBundle(source, { SKILLHUB_API_KEY: process.env.SKILLHUB_API_KEY || '' }, new Request('https://mind.internal/api/skillhub/bundle', { signal: preparation })) });
    return runE2BAgent({ apiKey: e2bKey, template: process.env.E2B_TEMPLATE_ID || '', runtimeArchive: fileURLToPath(new URL('../sandbox-runtime.tar.gz', import.meta.url)), ...args, skills: prepared, referenceReader: (id, options) => resources.read(args.job.project.id,id,{...options,visionEnabled:args.connection.visionEnabled===true}) });
  };
  return { RESOURCE_SERVICE: resources, GENERATION_JOBS: new GenerationJobs(projects), SANDBOX_CONFIGURED: sandboxConfigured, PROJECT_SERVICE: projects, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || '', RELEASE_SHA: release, CONNECTION_ENCRYPTION_KEY: secret, SKILLHUB_API_KEY: process.env.SKILLHUB_API_KEY || '', AGENT_RUNNER: agentRunner, AGENT_TEST: testPiConnection };
}
export function createLocalServer(env) {
  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('PUBLIC_ORIGIN 必须是完整 HTTPS 站点来源');
    publicOrigin = url.origin;
  }
const server = http.createServer(async (req, res) => {
  try {
    const authority = req.headers.host || '';
    const port = server.address()?.port;
    const allowedHosts = publicOrigin ? [new URL(publicOrigin).host] : ['localhost:' + port, '127.0.0.1:' + port];
    if (!allowedHosts.includes(authority.toLowerCase())) {
      res.writeHead(403); res.end('Invalid host.'); return;
    }
    const download = new Map(Object.entries({
      '/downloads/mind-source.zip': { file: 'mind-source.zip', type: 'application/zip' },
      '/downloads/mind-source.sha256': { file: 'mind-source.sha256', type: 'text/plain; charset=utf-8' },
    })).get(new URL(req.url, 'http://localhost').pathname);
    if (download) {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      const directory = env.SOURCE_DOWNLOAD_DIR ? pathToFileURL(resolve(env.SOURCE_DOWNLOAD_DIR) + '/') : new URL('../downloads/', import.meta.url);
      const file = new URL(download.file, directory);
      let info;
      try { info = await stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; res.writeHead(404); res.end('Source package is not published in this release.'); return; }
      res.writeHead(200, { 'Content-Type': download.type, 'Content-Length': info.size, 'Content-Disposition': 'attachment; filename="' + download.file + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(file), res);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    for (const name of [...headers.keys()]) if (name.startsWith('oai-authenticated-')) headers.delete(name);
    const cookies = (headers.get('cookie') || '').split(';').map(part => {
      const text = part.trim();
      return !publicOrigin && text.startsWith('branch-local-connection=') ? '__Host-branch-connection=' + text.slice('branch-local-connection='.length) : text;
    }).join('; ');
    headers.set('cookie', cookies);
    headers.set('CF-Connecting-IP', publicOrigin ? headers.get('x-real-ip') || '127.0.0.1' : '127.0.0.1');
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const options = { method: req.method, headers, signal: abort.signal };
    if (!['GET', 'HEAD'].includes(req.method)) { options.body = req; options.duplex = 'half'; }
    const request = new Request((publicOrigin || 'http://' + authority) + req.url, options);
    const result = await worker.fetch(request, env);
    res.statusCode = result.status;
    for (const [name, value] of result.headers) {
      // Local-only HTTP uses its own cookie name; hosted HTTPS retains __Host- and Secure.
      res.setHeader(name, name === 'set-cookie' && !publicOrigin ? value.replace('__Host-branch-connection=', 'branch-local-connection=').replace(/; Secure/g, '') : value);
    }
    if (result.body) {
      for await (const chunk of result.body) {
        if (res.destroyed) break;
        if (!res.write(Buffer.from(chunk))) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
      }
    }
    res.end();
  } catch {
    if (res.destroyed) return;
    if (!res.headersSent) {res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store' });res.end(JSON.stringify({error:'服务暂时不可用，请稍后重试',code:'INTERNAL_ERROR'}));}
    else res.end();
  }
});
  return server;
}
export async function startLocalServer() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be between 1 and 65535');
  const env = await localEnvironment();
  const server = createLocalServer(env);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; server.close();
    let timer;
    await Promise.race([env.GENERATION_JOBS.shutdown(), new Promise(resolve => { timer = setTimeout(resolve, 25000); })]);
    clearTimeout(timer); server.closeAllConnections(); env.PROJECT_SERVICE.close(); process.exit(0);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭原进程，或设置 PORT 后重试。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n枝想 Pi Agent 已启动：${process.env.PUBLIC_ORIGIN || 'http://localhost:' + port}\n`);
    console.log('在模型设置中填写支持工具调用与流式响应的模型。执行记录会实时显示。');
    console.log('请保持此窗口开启，按 Ctrl+C 停止。');
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startLocalServer();
