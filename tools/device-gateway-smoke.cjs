const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createGateway } = require('./device-api-gateway.cjs');
const { accounts } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.cache/device-local/gateway.json')));
const server = createGateway(accounts);
assert.throws(() => createGateway([accounts[0], { ...accounts[1], name: accounts[0].name }]), /Invalid/);
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, account, body, token, method = body ? 'POST' : 'GET', idempotency = randomUUID()) {
    const response = await fetch(base + route, { method, headers: {
      ...(account ? { 'X-Device-Test-Key': account.key } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(['POST', 'PUT', 'DELETE'].includes(method) ? { 'Idempotency-Key': idempotency } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await request('/api/v1/me')).status, 401);
    assert.equal((await request('/internal/metrics', accounts[0])).status, 404);
    assert.equal((await request('/api/v1/me', accounts[0])).status, 401);
    const raw = (body, type = 'application/json') => fetch(base + '/api/v1/session/wechat', { method: 'POST', headers: { 'X-Device-Test-Key': accounts[0].key, 'Content-Type': type, 'Idempotency-Key': randomUUID() }, body });
    assert.equal((await raw('{')).status, 400);
    assert.equal((await raw('{}', 'text/plain')).status, 415);
    assert.equal((await raw(JSON.stringify({ padding: 'x'.repeat(262145) }))).status, 413);
    assert.equal((await request('/api/v1/%6de', accounts[0])).status, 404);
    const login = async account => {
      const result = await request('/api/v1/session/wechat', account, { code: 'test:arbitrary-identity', deviceId: `gateway-${randomUUID()}` });
      assert.equal(result.status, 201); return result.body;
    };
    const a = await login(accounts[0]), a2 = await login(accounts[0]), b = await login(accounts[1]);
    assert.equal(a.userId, a2.userId); assert.notEqual(a.userId, b.userId);
    assert.equal((await request('/api/v1/me', accounts[1], null, a.accessToken)).status, 401);
    for (const route of ['/api/v1/me', '/api/v1/me/progress', '/api/v1/me/learning-score', '/api/v1/ranking-options']) assert.equal((await request(route, accounts[0], null, a.accessToken)).status, 200);
    assert.equal((await request('/api/v1/me/local-import', accounts[0], {}, a.accessToken)).status, 404);
    assert.equal((await request('/api/v1/session/refresh', accounts[1], { refreshToken: a.refreshToken })).status, 401);
    const refreshKey = randomUUID();
    const rotated = await request('/api/v1/session/refresh', accounts[0], { refreshToken: a.refreshToken }, null, 'POST', refreshKey);
    assert.equal(rotated.status, 200);
    const repeated = await request('/api/v1/session/refresh', accounts[0], { refreshToken: a.refreshToken }, null, 'POST', refreshKey);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.accessToken, rotated.body.accessToken);
    assert.equal((await request('/api/v1/session/refresh', accounts[0], { refreshToken: a.refreshToken })).status, 401);
    for (const [account, token] of [[accounts[0], rotated.body.accessToken], [accounts[0], a2.accessToken], [accounts[1], b.accessToken]]) assert.equal((await request('/api/v1/session/current', account, null, token, 'DELETE')).status, 200);
    assert.equal((await request('/api/v1/me', accounts[0], null, rotated.body.accessToken)).status, 401);
    console.log('gateway.smoke.passed missing-key=denied unknown-route=denied arbitrary-identity=fixed token-account=bound refresh=bound logout=denied reads=ok');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
