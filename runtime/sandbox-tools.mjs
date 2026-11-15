import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
const root = '/workspace/task';
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const output = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
async function scopedPath(path, writing = false) {
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw Error('只允许访问当前任务目录');
  if (writing) { await mkdir(dirname(target), { recursive: true }); const parent = await realpath(dirname(target)); if (parent !== root && !parent.startsWith(root + sep)) throw Error('路径超出当前任务目录'); }
  try { const actual = await realpath(target); if (!actual.startsWith(root + sep)) throw Error('路径超出当前任务目录'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return target;
}
export function sandboxTools(signal) {
  return [
    { name: 'read_task_file', label: '读取任务文件', description: '读取当前任务目录中的 Skill 引用、脚本或生成文件（最多 32KB）。使用相对路径。', parameters: schema({ path: string(300) }), execute: async (id, args) => {
      const path = await scopedPath(args.path), handle = await import('node:fs/promises').then(fs => fs.open(path));
      try { const bytes = Buffer.alloc(32769); const { bytesRead } = await handle.read(bytes); return output({ content: bytes.subarray(0, Math.min(bytesRead, 32768)).toString('utf8'), truncated: bytesRead > 32768 }); } finally { await handle.close(); }
    } },
    { name: 'write_task_file', label: '写入任务文件', description: '在当前任务目录写入文本，供脚本处理；任务结束后文件销毁。', parameters: schema({ path: string(300), content: { type: 'string', maxLength: 32000 } }), execute: async (id, args) => { await writeFile(await scopedPath(args.path, true), args.content); return output({ written: args.path }); } },
    { name: 'run_command', label: '执行沙箱命令', description: '在任务容器内执行 shell 命令，可运行已下载的 Skill 脚本、Node.js 或 Python3。无网络、无宿主机文件、无密钥；最长 15 秒，输出最多 32KB。不得声称执行未成功的步骤。', parameters: schema({ command: string(4000) }), execute: async (id, args) => {
      return await new Promise((done, fail) => {
        const child = spawn('/bin/sh', ['-c', args.command], { cwd: root, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/workspace/task', LANG: 'C.UTF-8' }, detached: true, stdio: ['ignore','pipe','pipe'] });
        let bytes = 0, truncated = false, expired = false; const chunks = [];
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const timer = setTimeout(() => { expired = true; kill(); }, 15000);
        signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
        const consume = data => { const keep = data.subarray(0, Math.max(0, 32768-bytes)); bytes += data.length; if (keep.length) chunks.push(keep); if (bytes > 32768) { truncated = true; kill(); } };
        child.stdout.on('data', consume); child.stderr.on('data', consume);
        child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', kill); fail(error); });
        child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); const result = { exitCode: code, output: Buffer.concat(chunks).toString('utf8'), timedOut: expired, truncated }; if (code !== 0 || expired) fail(Error('沙箱命令未完成：' + JSON.stringify(result))); else done(output(result)); });
      });
    } },
  ];
}
