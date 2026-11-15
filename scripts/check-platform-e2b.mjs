// Run as the application user during deployment; never print credentials or raw SDK errors.
import { Sandbox } from 'e2b';
if (!process.env.E2B_API_KEY) { console.log('E2B platform key is not configured.'); process.exit(0); }
let sandbox;
try {
  sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY, ...(process.env.E2B_TEMPLATE_ID ? { template: process.env.E2B_TEMPLATE_ID } : {}), allowInternetAccess: false, timeoutMs: 60000, requestTimeoutMs: 20000, metadata: { application: 'mind', purpose: 'deployment-check' } });
  const result = await sandbox.commands.run('printf mind-platform-ready', { timeoutMs: 10000 });
  if (result.stdout !== 'mind-platform-ready') throw Error('Unexpected command output');
  console.log('Application user can create and execute in an isolated E2B sandbox.');
} catch { console.error('E2B platform connectivity check failed. Check platform key, template, quota and outbound HTTPS.'); process.exitCode = 1; }
finally {
  if (sandbox) { try { await sandbox.kill({ requestTimeoutMs: 10000 }); console.log('Platform check sandbox destroyed.'); } catch { console.error('Platform check cleanup not confirmed; 60-second TTL applies.'); process.exitCode = 1; } }
}
