import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const digest = value => createHash('sha256').update(value).digest('hex');
export async function prepareSkillSnapshot({ skills, projectId, cacheDirectory, loadBundle, signal, emit = () => {} }) {
  const result = []; let total = 0;
  const directory = join(cacheDirectory, digest(projectId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  emit({ type: 'sandbox_preparing', count: skills.length });
  for (const skill of skills) {
    signal?.throwIfAborted();
    let files = [];
    if (skill.origin?.provider === 'skillhub') {
      const key = digest(skill.origin.slug + '@' + skill.origin.version), file = join(directory, key + '.json');
      let bundle;
      try { bundle = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!bundle) {
        bundle = await loadBundle(skill.origin);
        const temporary = file + '.' + randomUUID();
        await writeFile(temporary, JSON.stringify(bundle), { mode: 0o600 }); await rename(temporary, file);
      }
      files = bundle.files;
    }
    const main = Buffer.from(skill.content, 'utf8');
    // The project's reviewed/edited SKILL.md is authoritative; other versioned files remain intact.
    files = [...files.filter(f => f.path.toUpperCase() !== 'SKILL.MD'), { path: 'SKILL.md', base64: main.toString('base64'), sha256: digest(main) }];
    for (const file of files) {
      const bytes = Buffer.from(file.base64, 'base64');
      if (digest(bytes) !== file.sha256) throw Error('Skill 快照完整性校验失败');
      total += bytes.length;
    }
    if (total > 16 * 1024 * 1024) throw Error('项目 Skill 文件总量超过 16MB，请减少启用项');
    result.push({ ...skill, directory: 'skills/' + digest(skill.id).slice(0, 24), files });
    emit({ type: 'skill_prepared', name: skill.name, version: skill.version, files: files.length });
  }
  // Bound stale cached versions independently inside each project's cache.
  const entries = await readdir(directory);
  if (entries.length > 60) {
    const ordered = await Promise.all(entries.map(async name => ({ name, time: (await stat(join(directory, name))).mtimeMs })));
    for (const entry of ordered.sort((a,b) => b.time-a.time).slice(60)) await unlink(join(directory, entry.name)).catch(() => {});
  }
  return result;
}
