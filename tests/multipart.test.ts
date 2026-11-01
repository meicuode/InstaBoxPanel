import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp, type Env } from '../src/worker/app';
import { uploadChunkBytes, maxMultipartBytes } from '../src/shared/files';
import { uploadScript } from '../src/worker/upload-script';

const origin = 'https://panel.test', headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Panel-Request': '1' };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('multipart APIs bind tickets to accounts and machines, validate chunks, and recover uncertain results', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-19', d1Databases: ['DB'] }));
  const env = { DB: await mf.getD1Database('DB') } as unknown as Env;
  let cookie = '', count = 0, losePart = false, wrongHash = false, jobs = 0, unsafeError = false;
  const sessions = new Map<string, { path: string; guard: string; size: number; parts: Map<number, string>; state: string; hash?: string }>();
  const incoming = new Map<string, Uint8Array>(), effects: { key: string; action: string; path: string }[] = [];
  const app = createApp({ fetcher: async (input, init = {}) => {
    count++;
    const url = new URL(String(input)), h = new Headers(init.headers), key = h.get('X-API-Key')!;
    assert.equal(url.origin, 'https://api.instabox.sh'); assert.equal(init.redirect, 'manual'); assert.equal(h.has('Cookie') || h.has('Origin') || h.has('X-Upload-Ticket'), false);
    if (url.pathname === '/v1/me') return Response.json({ userId: key.endsWith('_a') ? 'a' : 'b' });
    if (url.pathname === '/v1/machines') return Response.json({ machines: [], nextCursor: null });
    if (url.pathname.endsWith('/files')) {
      assert.equal(init.method, 'PUT'); const path = url.searchParams.get('path')!;
      assert.match(path, /^\/data\/home\/\.instabox-upload-[0-9a-f-]{36}\/incoming-[0-9a-f-]{36}$/);
      assert.equal(url.searchParams.get('parents'), 'false');
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer()); incoming.set(path, bytes);
      if (losePart) { losePart = false; throw new Error('lost upstream upload reply'); }
      return Response.json({ path, size: bytes.length, sha256: wrongHash ? 'f'.repeat(64) : digest(bytes), mode: '0644', created: true });
    }
    assert.ok(url.pathname.endsWith('/exec'));
    const body = JSON.parse(String(init.body)); assert.equal(body.argv[0], 'bash'); assert.equal(body.argv[1], '-c'); assert.equal(body.argv[2], uploadScript); assert.equal(body.noHistory, true);
    const [, , , , action, path, id, guard, total, , index, nonce, hash] = body.argv;
    effects.push({ key, action, path });
    const sessionKey = key + ':' + url.pathname + ':' + id;
    if (action === 'init' && !sessions.has(sessionKey)) sessions.set(sessionKey, { path, guard, size: Number(total), parts: new Map(), state: 'uploading' });
    const session = sessions.get(sessionKey)!; assert.ok(session); assert.equal(session.guard, guard); assert.equal(session.path, path);
    if (unsafeError) return Response.json({ exitCode: 1, timedOut: false, truncated: false, stdout: 'PANEL_UPLOAD_V1 ' + guard + '\nERROR ' + key + '\nEND\n', stderr: key });
    if (action === 'accept') {
      const bytes = incoming.get('/data/home/.instabox-upload-' + id + '/incoming-' + nonce)!; assert.equal(digest(bytes), hash); session.parts.set(Number(index), hash);
    }
    if (action === 'finish') { jobs++; session.state = 'merging'; }
    if (action === 'status' && session.state === 'merging') { session.state = 'complete'; session.hash = digest(new Uint8Array([0, 1, 255, 2])); }
    if (action === 'cleanup') { sessions.delete(sessionKey); return Response.json({ exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false }); }
    const stdout = ['login profile banner', 'PANEL_UPLOAD_V1 ' + guard, 'PATH ' + Buffer.from(path).toString('base64'), 'STATE ' + session.state,
      ...[...session.parts].map(([i, sha]) => 'PART ' + i + ' ' + sha), ...(session.state === 'complete' ? ['RESULT ' + session.size + ' ' + session.hash + ' 644 true'] : []), 'END', ''].join('\n');
    return Response.json({ exitCode: 0, timedOut: false, stdout, stderr: key, truncated: false });
  } });
  async function call(path: string, method = 'POST', body?: unknown, cookieValue = cookie, extra = {}) {
    const r = await app.fetch(new Request(origin + path, { method, headers: { ...headers, ...(cookieValue ? { Cookie: cookieValue } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: r.status, data: await r.json() as any };
  }
  async function chunk(base: string, id: string, ticket: string, bytes: Uint8Array, index = 0, extra = {}, cookieValue = cookie) {
    const r = await app.fetch(new Request(origin + base + '/' + id + '/parts/' + index, { method: 'PUT', headers: { ...headers, Cookie: cookieValue, 'Content-Type': 'application/octet-stream', 'X-Upload-Ticket': ticket, 'X-Chunk-SHA256': digest(bytes), ...extra }, body: new Uint8Array(bytes) }), env);
    return { status: r.status, data: await r.json() as any };
  }
  try {
    const setup = await app.fetch(new Request(origin + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ username: 'multipart-admin', password: 'multipart-test-password' }) }), env);
    assert.equal(setup.status, 201); cookie = setup.headers.get('Set-Cookie')!.split(';')[0];
    const a = (await call('/api/accounts', 'POST', { label: 'A', apiKey: 'ibk_multipart_a' })).data.account;
    const b = (await call('/api/accounts', 'POST', { label: 'B', apiKey: 'ibk_multipart_b' })).data.account;
    const base = '/api/accounts/' + a.id + '/machines/m_a/files/uploads';
    const id = crypto.randomUUID(), body = { uploadId: id, path: '/data/home/literal $(command) 中文.bin', size: 4, parents: false, overwrite: false };
    await t.test('JSON initiation and binary chunks both require a real session and same-origin request headers', async () => {
      const before = count;
      assert.equal((await call(base, 'POST', body, '')).status, 401);
      assert.equal((await call(base, 'POST', body, cookie, { Origin: 'https://evil.test' })).status, 403);
      assert.equal((await chunk(base, id, 'fake', new Uint8Array(4), 0, {}, '')).status, 401);
      assert.equal((await chunk(base, id, 'fake', new Uint8Array(4), 0, { 'X-Panel-Request': '' })).status, 403);
      assert.equal(count, before);
    });
    let ticket = '';
    await t.test('creates a sealed, repeatable session while keeping paths as argv and private credentials out of responses', async () => {
      const first = await call(base, 'POST', body); assert.equal(first.status, 200); ticket = first.data.ticket;
      assert.equal(first.data.chunkSize, uploadChunkBytes); assert.equal(first.data.path, body.path);
      assert.equal(JSON.stringify(first).includes('ibk_'), false); assert.equal(first.data.guard, undefined);
      assert.equal((await call(base, 'POST', body)).status, 200); assert.equal(sessions.size, 1);
      const before = count;
      for (const size of [0, -1, '4', 2.5, maxMultipartBytes + 1]) assert.equal((await call(base, 'POST', { ...body, size })).status, 400);
      assert.equal(count, before);
    });
    await t.test('forged, cross-account, cross-machine and wrong-session tickets fail before upstream calls', async () => {
      const before = count;
      for (const [url, token] of [[base + '/' + id + '/status', ticket + 'x'], [base.replace(a.id, b.id) + '/' + id + '/status', ticket], [base.replace('/m_a/', '/m_b/') + '/' + id + '/status', ticket], [base + '/' + crypto.randomUUID() + '/status', ticket]])
        assert.equal((await call(url, 'POST', { ticket: token })).status, 400);
      assert.equal(count, before);
    });
    await t.test('chunk bounds and both sides of SHA-256 verification prevent publishing malformed data', async () => {
      const bytes = new Uint8Array([0, 1, 255, 2]), before = count;
      assert.equal((await chunk(base, id, ticket, bytes, 1)).status, 400);
      assert.equal((await chunk(base, id, ticket, bytes, 0, { 'X-Chunk-SHA256': 'not-a-hash' })).status, 400);
      assert.equal((await chunk(base, id, ticket, bytes, 0, { 'Content-Length': String(uploadChunkBytes + 1) })).status, 400);
      assert.equal(count, before);
      wrongHash = true; assert.equal((await chunk(base, id, ticket, bytes)).status, 502); wrongHash = false;
      assert.equal((await call(base + '/' + id + '/status', 'POST', { ticket })).data.parts.length, 0);
      losePart = true; assert.equal((await chunk(base, id, ticket, bytes)).status, 502);
      assert.equal((await chunk(base, id, ticket, bytes)).status, 200);
      assert.deepEqual((await call(base + '/' + id + '/status', 'POST', { ticket })).data.parts, [{ index: 0, sha256: digest(bytes) }]);
    });
    await t.test('unrecognized machine output never becomes a public error code or leaks credentials', async () => {
      unsafeError = true;
      const result = await call(base + '/' + id + '/status', 'POST', { ticket });
      unsafeError = false;
      assert.equal(result.status, 400); assert.equal(result.data.error.code, 'invalid_upload'); assert.equal(JSON.stringify(result).includes('ibk_'), false);
    });
    await t.test('a lost finish response is resolved by status polling without a second merge, and cleanup is scoped', async () => {
      const started = await call(base + '/' + id + '/finish', 'POST', { ticket, overwrite: false }); assert.equal(started.data.state, 'merging');
      const done = await call(base + '/' + id + '/status', 'POST', { ticket }); assert.equal(done.data.state, 'complete'); assert.equal(done.data.result.size, 4);
      await call(base + '/' + id + '/status', 'POST', { ticket }); assert.equal(jobs, 1);
      assert.equal((await call(base + '/' + id, 'DELETE', { ticket })).status, 200); assert.equal(sessions.size, 0);
      assert.equal(effects.some(e => e.key !== 'ibk_multipart_a'), false);
    });
  } finally { await mf.dispose(); }
});
