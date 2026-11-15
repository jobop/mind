// Runs exclusively inside a disposable E2B virtual machine; no real model credential enters it.
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { runPiAgent, AgentRunError } from './pi-agent.mjs';
import { createModelStream } from './model-stream.mjs';
import { sandboxTools } from './sandbox-tools.mjs';
const pending = new Map(); let sequence = 0, started = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function rpc(operation, payload) { const id = ++sequence; return new Promise((done, fail) => { pending.set(id, { done, fail }); send({ type: 'rpc', id, operation, payload }); }); }
const modelStream = createModelStream({send,nextId:()=>++sequence});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  try {
    const message = JSON.parse(line);
    if (modelStream.handle(message)) return;
    if (message.type === 'rpc_result') { const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.fail(Object.assign(Error(message.error),{code:message.code})) : p.done(message.result); } return; }
    if (message.type !== 'start' || started) return; started = true;
    const { job, connection, skills } = JSON.parse(await readFile('/workspace/task/input.json', 'utf8'));
    await unlink('/workspace/task/input.json');
    await mkdir('/workspace/task', { recursive: true });
    for (const skill of skills) for (const file of skill.files || []) {
      const path = resolve('/workspace/task', skill.directory, file.path);
      if (!path.startsWith(resolve('/workspace/task', skill.directory) + '/')) throw Error('Skill 文件路径不正确');
      const bytes = Buffer.from(file.base64, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Skill 文件校验失败');
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 });
    }
    if (job.mapContext) await writeFile('/workspace/task/map-context.json', JSON.stringify(job.mapContext), { mode: 0o600 });
    send({ type: 'sandbox_ready', count: skills.length, isolation: 'e2b', network: 'none' });
    // Only this exact provider request is brokered. Arbitrary fetch and script network access are unavailable.
    globalThis.fetch = async (url, options) => {
      if (String(url) !== connection.url) throw Error('沙箱不允许直接联网');
      return modelStream.fetchModel(options.body, options.signal);
    };
    const controller = new AbortController();
    const result = await runPiAgent({ connection, job, skills, emit: send, signal: controller.signal, executionTools: sandboxTools(controller.signal), skillLoader: async skill => readFile(resolve('/workspace/task', skill.directory, 'SKILL.md'), 'utf8'), pageReader: (url) => rpc('page', { url }), referenceReader: (id, options) => rpc('reference', { id, path: options.path || '', directory: options.directory===true }) });
    await modelStream.drain();
    await new Promise(done => process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n', done)); process.exit(0);
  } catch (error) { const known = error instanceof AgentRunError; await new Promise(done => process.stdout.write(JSON.stringify({ type: 'error', error: known ? error.message : '沙箱 Agent 未完成任务，请检查工具记录后重试', code: known ? error.code : 'AGENT_SANDBOX_FAILED' }) + '\n', done)); process.exit(1); }
});
