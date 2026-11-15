import { spawnSync } from 'node:child_process';
for (const path of ['tests/client.test.mjs', 'tests/server.test.mjs', 'tests/skillhub.test.mjs', 'tests/pi-agent.test.mjs', 'tests/local-transport.test.mjs', 'tests/projects.test.mjs', 'tests/e2b.test.mjs', 'tests/generation-jobs.test.mjs', 'tests/map-context.test.mjs', 'tests/model-stream.test.mjs']) {
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
