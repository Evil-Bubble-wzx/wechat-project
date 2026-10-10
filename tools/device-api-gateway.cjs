const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual, createHmac } = require('node:crypto');
const routes = [
  ['POST', /^\/api\/v1\/session\/(wechat|refresh)$/], ['DELETE', /^\/api\/v1\/session\/current$/],
  ['GET', /^\/api\/v1\/me$/], ['GET', /^\/api\/v1\/me\/progress(?:\/[A-Za-z0-9_-]{1,128})?$/],
  ['PUT', /^\/api\/v1\/me\/progress\/[A-Za-z0-9_-]{1,128}$/], ['POST', /^\/api\/v1\/me\/(words\/sync|quiz-attempts)$/],
  ['GET', /^\/api\/v1\/(me\/learning-score|ranking-options|rankings)$/],
  ['GET', /^\/api\/v1\/rankings\/[A-Za-z0-9_-]{1,128}\/quizzes$/],
];
function createGateway(accounts) {
  if (accounts.length !== 2 || accounts.some(a => !['primary', 'isolation'].includes(a.name) || a.identity !== `device-restricted-${a.name}` || !/^[a-f0-9]{64}$/.test(a.key)) || accounts[0].name === accounts[1].name || accounts[0].key === accounts[1].key) throw new Error('Invalid gateway account configuration');
  const access = new Map(), refresh = new Map();
  const quota = new Map();
  const deny = (res, status) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { code: 'TEST_GATEWAY_REJECTED' } })); };
  return http.createServer(async (req, res) => {
    try {
      const key = typeof req.headers['x-device-test-key'] === 'string' ? req.headers['x-device-test-key'] : '';
      const account = accounts.find(a => key.length === a.key.length && timingSafeEqual(Buffer.from(key), Buffer.from(a.key)));
      if (!account) return deny(res, 401);
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('..') || req.url.includes('\\')) return deny(res, 404);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.includes('%') || !routes.some(([method, regex]) => method === req.method && regex.test(url.pathname))) return deny(res, 404);
      const now = Date.now();
      for (const map of [access, refresh]) for (const [token, entry] of map) if (entry.until <= now) map.delete(token);
      const bucket = quota.get(account.name);
      const count = bucket && now - bucket.start < 60000 ? bucket : { start: now, count: 0 };
      quota.set(account.name, count);
      if (++count.count > 120 || access.size + refresh.size > 1000) return deny(res, 429);
      if (['POST', 'PUT'].includes(req.method) && !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return deny(res, 415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) return deny(res, 413); chunks.push(chunk); }
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text ? JSON.parse(text) : undefined;
      const login = url.pathname === '/api/v1/session/wechat';
      const rotate = url.pathname === '/api/v1/session/refresh';
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (login) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return deny(res, 400);
        const idempotency = req.headers['idempotency-key'];
        if (typeof idempotency !== 'string' || idempotency.length < 8 || idempotency.length > 128) return deny(res, 400);
        body.code = `test:${account.identity}#ticket-${createHmac('sha256', account.key).update(idempotency).digest('hex')}`;
      } else if (rotate) {
        const entry = body && refresh.get(body.refreshToken);
        if (!entry || entry.account !== account.name || (entry.replayedWith && entry.replayedWith !== req.headers['idempotency-key'])) return deny(res, 401);
      } else if (access.get(bearer)?.account !== account.name) return deny(res, 401);
      const headers = {};
      for (const name of ['authorization', 'content-type', 'idempotency-key']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      const response = await fetch('http://127.0.0.1:3100' + url.pathname + url.search, { method: req.method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
      const data = await response.text();
      if (response.ok && (login || rotate)) {
        const session = JSON.parse(data);
        if (!session.accessToken || !session.refreshToken) return deny(res, 502);
        access.set(session.accessToken, { account: account.name, until: Date.parse(session.accessTokenExpiresAt) });
        refresh.set(session.refreshToken, { account: account.name, until: Date.parse(session.refreshTokenExpiresAt) });
        if (rotate) refresh.get(body.refreshToken).replayedWith = req.headers['idempotency-key'];
      }
      if (response.ok && req.method === 'DELETE') access.delete(bearer);
      const out = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      for (const name of ['x-api-contract-version', 'x-request-id']) if (response.headers.has(name)) out[name] = response.headers.get(name);
      res.writeHead(response.status, out); res.end(data);
    } catch { if (!res.headersSent) deny(res, 400); else res.destroy(); }
  });
}
if (require.main === module) {
  const { accounts } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.cache/device-local/gateway.json')));
  const server = createGateway(accounts);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(4181, '127.0.0.1', () => console.log('Restricted test gateway listening on localhost:4181; no public tunnel'));
}
module.exports = { createGateway };
