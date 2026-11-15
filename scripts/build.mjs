import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const assets = {};
for (const [path, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/resources.js', 'resources.js', 'text/javascript; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ['/skills.js', 'skills.js', 'text/javascript; charset=utf-8'],
  ['/background-jobs.js', 'background-jobs.js', 'text/javascript; charset=utf-8'],
  ['/projects.js', 'projects.js', 'text/javascript; charset=utf-8'],
  ['/skillhub.js', 'skillhub.js', 'text/javascript; charset=utf-8'],
]) assets[path] = { body: await readFile(new URL('../web/' + file, import.meta.url), 'utf8'), type };
const worker = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const skills = await readFile(new URL('../web/skills.js', import.meta.url), 'utf8');
const skillhub = await readFile(new URL('../worker/skillhub.js', import.meta.url), 'utf8');
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/server/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/server/index.js', import.meta.url), 'const ASSETS = ' + JSON.stringify(assets) + ';\n' + skills + '\n' + skillhub + '\n' + worker);
console.log('Built application with embedded HTML, JavaScript and CSS.');
