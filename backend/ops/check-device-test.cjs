// Read-only preflight: no installation, service startup, or secret reads.
const { spawnSync } = require('node:child_process');
const http = require('node:http');

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return { available: result.error?.code !== 'ENOENT', ok: !result.error && result.status === 0,
    output: (result.stdout || '').trim() };
}

function health(path) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:3100/health/${path}`, (response) => {
      response.resume();
      resolve({ item: `API /health/${path}`, status: response.statusCode === 200 ? 'OK' : 'CHECK', detail: `HTTP ${response.statusCode}` });
    });
    request.setTimeout(3000, () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ item: `API /health/${path}`, status: 'UNAVAILABLE', detail: 'No HTTP response on localhost:3100' }));
  });
}

async function main() {
  const checks = [{ item: 'Node', status: Number(process.versions.node.split('.')[0]) >= 24 ? 'OK' : 'CHECK', detail: process.version }];
  const docker = command('docker', ['info', '--format', '{{.ServerVersion}}']);
  checks.push({ item: 'Docker engine', status: docker.ok ? 'OK' : docker.available ? 'UNAVAILABLE' : 'MISSING',
    detail: docker.ok ? docker.output : 'Verify installation, engine startup, and current process permissions in Docker Desktop' });
  const tunnel = command('cloudflared', ['--version']);
  checks.push({ item: 'cloudflared', status: tunnel.ok ? 'AVAILABLE' : tunnel.available ? 'CHECK' : 'MISSING',
    detail: tunnel.ok ? tunnel.output : 'Not usable on PATH; no tunnel created' });
  checks.push(...await Promise.all(['live', 'ready'].map(health)));
  console.table(checks);
  console.log('Read-only preflight complete. HTTPS, WeChat login, audio, and phone sync need separate verification.');
}
main().catch(() => { console.error('Preflight failed unexpectedly'); process.exitCode = 1; });
