import { mkdir, rm, cp, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)), stage = join(root, '.sandbox-build');
try {
  await mkdir(join(stage, 'bin'), { recursive: true });
  await cp(process.execPath, join(stage, 'bin/node'));
  for (const name of ['runtime','package.json','package-lock.json','THIRD_PARTY']) await cp(join(root,name),join(stage,name),{ recursive:true });
  await cp(await realpath(join(root,'node_modules')), join(stage,'node_modules'), { recursive: true });
  execFileSync('tar', ['-czf', join(root,'sandbox-runtime.tar.gz'), '-C', stage, '.']);
  console.log('Credential-free E2B runtime bundle created.');
} finally { await rm(stage, { recursive: true, force: true }); }
