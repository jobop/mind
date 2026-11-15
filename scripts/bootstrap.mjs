import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 19) {
  console.error('Pi Agent 需要 Node.js 22.19 或更新的 LTS 版本，请先升级 Node.js。');
  process.exit(1);
}
let installed = true;
try {
  for (const [name, version, entry] of [
    ['@earendil-works/pi-agent-core', '1.5.2', 'dist/index.js'],
    ['@earendil-works/pi-ai', '1.5.2', 'dist/index.js'],
    ['e2b', '2.64.0', 'dist/index.js'],
    ['ipaddr.js', '2.3.0', 'lib/ipaddr.js'],
  ]) {
    const directory = new URL('../node_modules/' + name + '/', import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    if (pkg.version !== version) throw Error('Dependency version mismatch');
    await access(new URL(entry, directory));
  }
}
catch { installed = false; }
if (!installed) {
  if (process.argv.includes('--check')) { console.error('Pi Agent 依赖缺失或版本不匹配，请运行 npm ci。'); process.exit(1); }
  console.log('首次启动：安装已锁定版本的 Pi Agent 依赖，请保持网络连接…');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.status !== 0) { console.error('依赖安装失败。请检查 npm 网络设置后，在本目录运行 npm ci 重试。'); process.exit(result.status || 1); }
}
if (process.argv.includes('--check')) { console.log('Pi Agent 1.5.2 运行依赖检查通过，无需安装。'); process.exit(0); }
const { startLocalServer } = await import('./local-server.mjs');
await startLocalServer();
