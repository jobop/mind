// Read only counts using the application's SQLite version; never inspect task inputs or credentials.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export function activeJobs(path) {
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_jobs'").get()) return 0;
    return db.prepare("SELECT count(*) AS count FROM generation_jobs WHERE status IN ('queued','running')").get().count;
  } finally { db.close(); }
}
async function main(path) {
  const deadline = performance.now() + 1260000;
  while (true) {
    const count = activeJobs(path);
    if (!count) { console.log('No active generation jobs; proceeding with deployment.'); return; }
    if (performance.now() >= deadline) throw Error('Generation jobs are still active. Leaving the running application unchanged; deploy again when idle.');
    console.log('Waiting for ' + count + ' active generation job(s) before restart.');
    await delay(10000);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
