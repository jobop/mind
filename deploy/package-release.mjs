import { cp, mkdir, rm, writeFile, readFile, realpath, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sha = argument('--sha', process.env.GITHUB_SHA || '');
const arch = argument('--arch', 'x64');
if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Release SHA must be a full 40-character Git commit SHA');
if (!['x64', 'arm64'].includes(arch) || process.platform !== 'linux') throw Error('Release packaging requires Linux and x64/arm64');
const output = join(root, '.release'), stage = join(output, 'stage');
const downloads = join(root, 'downloads');
await mkdir(downloads, { recursive: true });
const sourceZip = join(downloads, 'mind-source.zip');
execFileSync('git', ['archive', '--format=zip', '--prefix=mind/', '--output=' + sourceZip, sha], { cwd: root });
const sourceDigest = createHash('sha256').update(await readFile(sourceZip)).digest('hex');
await writeFile(join(downloads, 'mind-source.sha256'), sourceDigest + '  mind-source.zip\n');
await rm(stage, { recursive: true, force: true }); await mkdir(join(stage, 'bin'), { recursive: true });
for (const name of ['dist', 'runtime', 'scripts', 'deploy', 'THIRD_PARTY', 'downloads']) await cp(join(root, name), join(stage, name), { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'README.md']) await cp(join(root, name), join(stage, name));
await cp(await realpath(join(root, 'node_modules')), join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true });
await writeFile(join(stage, 'RELEASE'), sha + '\n');
await writeFile(join(stage, 'NODE_ARCH'), arch + '\n');
if (arch === process.arch) {
  await cp(process.execPath, join(stage, 'bin/node'));
  try { await cp(resolve(dirname(process.execPath), '../LICENSE'), join(stage, 'bin/NODE_LICENSE')); } catch {}
} else {
  const filename = `node-${process.version}-linux-${arch}.tar.xz`, base = `https://nodejs.org/dist/${process.version}/`;
  const [archiveResponse, sumsResponse] = await Promise.all([fetch(base + filename), fetch(base + 'SHASUMS256.txt')]);
  if (!archiveResponse.ok || !sumsResponse.ok) throw Error('Unable to download the official Node.js runtime');
  const bytes = Buffer.from(await archiveResponse.arrayBuffer()), sums = await sumsResponse.text();
  const expected = sums.split('\n').find(line => line.trim().endsWith(' ' + filename))?.split(/\s+/)[0];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Node.js checksum mismatch');
  const archive = join(output, filename); await writeFile(archive, bytes);
  execFileSync('tar', ['-xJf', archive, '-C', output, `node-${process.version}-linux-${arch}/bin/node`, `node-${process.version}-linux-${arch}/LICENSE`]);
  await cp(join(output, `node-${process.version}-linux-${arch}/bin/node`), join(stage, 'bin/node'));
  await cp(join(output, `node-${process.version}-linux-${arch}/LICENSE`), join(stage, 'bin/NODE_LICENSE'));
}
await chmod(join(stage, 'bin/node'), 0o755);
// A credential-free runtime is uploaded through E2B's file API; no npm install or internet inside the task VM.
execFileSync('tar', ['-czf', join(stage, 'sandbox-runtime.tar.gz'), '-C', stage, 'bin', 'runtime', 'node_modules', 'package.json', 'package-lock.json']);
const archive = join(output, 'mind-release.tar.gz');
execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(join(output, 'mind-release.sha256'), digest + '  mind-release.tar.gz\n');
console.log('Packaged release ' + sha + ' for Linux ' + arch + ' with Node.js and Pi runtime dependencies.');
