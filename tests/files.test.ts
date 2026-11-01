import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createApp, type Env } from '../src/worker/app';
import { maxUploadBytes } from '../src/shared/files';
import type { Fetcher } from '../src/worker/instabox';

const origin = 'https://panel.test';
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Panel-Request': '1' };
const stamp = '2026-11-01T00:00:00Z';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const meta = { size: 0, mode: '-rw-r--r--', modTime: stamp };

test('file management authenticates, isolates accounts and preserves streamed bytes', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-19', d1Databases: ['DB'] }));
  const env = { DB: await mf.getD1Database('DB') } as unknown as Env;
  const stored = new Map<string, Uint8Array>(), calls: { url: URL; method: string; key: string; body?: any }[] = [];
  let cookie = '', failure = '', loseWrite = false, commands = 0, receivedBytes = 0;
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET', h = new Headers(init.headers), key = h.get('X-API-Key')!;
    assert.equal(url.origin, 'https://api.instabox.sh'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    assert.equal(h.has('Cookie') || h.has('Origin') || h.has('X-Panel-Request') || h.has('Cf-Access-Jwt-Assertion'), false);
    const call = { url, method, key, body: undefined as any }; calls.push(call);
    if (url.pathname === '/v1/me') return Response.json({ userId: key.endsWith('_b') ? 'b' : 'a' });
    if (url.pathname === '/v1/machines') return Response.json({ machines: [], nextCursor: null });
    if (url.pathname.includes('/m_a/') && key.endsWith('_b')) return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 });
    if (failure === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
    if (['scope', 'missing_parent', 'no_space', 'machine_not_running', 'html'].includes(failure)) {
      if (failure === 'html') return new Response('private ' + key, { status: 502 });
      const code = failure === 'scope' ? 'insufficient_scope' : failure;
      return Response.json({ error: { code, message: key } }, { status: failure === 'scope' ? 403 : failure === 'no_space' ? 507 : 409 });
    }
    if (url.pathname.endsWith('/exec')) {
      commands++; call.body = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(call.body).sort(), ['argv', 'cwd', 'timeoutSeconds']);
      const argv = call.body.argv;
      assert.equal(call.body.cwd, '/'); assert.equal(call.body.timeoutSeconds, 20);
      return Response.json({ exitCode: failure === 'command' ? 1 : 0, timedOut: failure === 'timeout', truncated: false,
        stdout: argv[0] === 'mv' && failure !== 'skip' ? 'renamed' : '', stderr: key });
    }
    const path = url.searchParams.get('path')!, bytes = stored.get(path);
    if (method === 'PUT') {
      assert.equal(h.get('Content-Type'), 'application/octet-stream');
      const result = new Uint8Array(await new Response(init.body).arrayBuffer());
      receivedBytes += result.length; stored.set(path, result);
      if (loseWrite) { loseWrite = false; throw new Error('response lost ' + key); }
      return Response.json({ path, size: failure === 'wrong_size' ? result.length + 1 : result.length, sha256: hash(result), mode: '0644', created: !bytes, secret: key }, { status: bytes ? 200 : 201 });
    }
    if (url.pathname.endsWith('/content')) {
      if (!bytes) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 10)); c.enqueue(bytes.subarray(10)); c.close(); } });
      return new Response(stream, { headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'text/html', 'X-API-Key': key, 'Set-Cookie': 'upstream=private', 'Location': 'https://evil.test' } });
    }
    assert.ok(url.pathname.endsWith('/files'));
    if (path === '/data/home') return Response.json({ ...meta, path, type: 'dir', secret: key,
      entries: failure === 'malformed' ? 'bad' : [{ ...meta, name: '<img onerror=alert(1)>', type: 'file', secret: key }] });
    if (!bytes) return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 });
    return Response.json({ ...meta, path, type: 'file', size: bytes.length, content: new TextDecoder().decode(bytes), secret: key });
  };
  const app = createApp({ fetcher });
  async function response(path: string, method = 'GET', body?: BodyInit, extra: Record<string, string> = {}, cookieValue = cookie) {
    return app.fetch(new Request(origin + path, { method, headers: { ...headers, ...(cookieValue ? { Cookie: cookieValue } : {}), ...extra }, body, duplex: 'half' } as RequestInit), env);
  }
  async function call(path: string, method = 'GET', body?: unknown, extra = {}, cookieValue = cookie) {
    const r = await response(path, method, body === undefined ? undefined : JSON.stringify(body), extra, cookieValue);
    return { status: r.status, body: await r.json() as any };
  }
  async function upload(base: string, path: string, bytes: BodyInit, options = '', extra = {}, cookieValue = cookie) {
    const r = await response(base + '/content?' + new URLSearchParams({ path }) + options, 'PUT', bytes, { 'Content-Type': 'application/octet-stream', ...extra }, cookieValue);
    return { status: r.status, body: await r.json() as any };
  }
  try {
    const setup = await response('/api/auth/setup', 'POST', JSON.stringify({ username: 'files-admin', password: 'files-test-password' }));
    assert.equal(setup.status, 201); cookie = setup.headers.get('Set-Cookie')!.split(';')[0];
    const a = (await call('/api/accounts', 'POST', { label: 'A', apiKey: 'ibk_files_a' })).body.account;
    const b = (await call('/api/accounts', 'POST', { label: 'B', apiKey: 'ibk_files_b' })).body.account;
    const base = '/api/accounts/' + a.id + '/machines/m_a/files';
    await t.test('anonymous, forged-cookie and cross-origin requests do not read or mutate upstream files', async () => {
      const before = calls.length;
      for (const fake of ['', '__Host-instabox-session=fake']) {
        assert.equal((await call(base, 'GET', undefined, {}, fake)).status, 401);
        assert.equal((await call(base + '/content?path=/test', 'GET', undefined, {}, fake)).status, 401);
        assert.equal((await upload(base, '/test', 'abc', '', {}, fake)).status, 401);
        assert.equal((await call(base + '/directory', 'POST', { path: '/test' }, {}, fake)).status, 401);
        assert.equal((await call(base, 'PATCH', { path: '/test', name: 'next' }, {}, fake)).status, 401);
        assert.equal((await call(base, 'DELETE', { path: '/test', confirmPath: '/test', recursive: false }, {}, fake)).status, 401);
      }
      assert.equal((await upload(base, '/test', 'abc', '', { Origin: 'https://evil.test' })).status, 403);
      assert.equal((await upload(base, '/test', 'abc', '', { 'X-Panel-Request': '' })).status, 403);
      assert.equal((await upload(base, '/test', 'abc', '', { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal(calls.length, before);
    });
    await t.test('lists only safe display fields and never falls back to another account key', async () => {
      const result = await call(base); assert.equal(result.status, 200); assert.equal(result.body.entries[0].name, '<img onerror=alert(1)>');
      assert.equal(JSON.stringify(result).includes('secret'), false);
      assert.equal((await call('/api/accounts/' + b.id + '/machines/m_a/files')).status, 404);
      assert.equal(calls.at(-1)!.key, 'ibk_files_b');
      failure = 'malformed'; assert.equal((await call(base)).status, 502); failure = '';
    });
    await t.test('rejects dangerous paths, root mutations, bad options and unconfirmed deletion before sending commands', async () => {
      const before = calls.length;
      for (const path of ['relative', '/a/../b', '/a/./b', '/a\0b', '/a\nb', '/' + '中'.repeat(1400)])
        assert.equal((await call(base + '?' + new URLSearchParams({ path }))).status, 400);
      for (const path of ['/', '////']) {
        assert.equal((await upload(base, path, '')).status, 400);
        assert.equal((await call(base, 'DELETE', { path, confirmPath: path, recursive: true })).status, 400);
      }
      assert.equal((await upload(base, '/test', 'a', '&parents=yes')).status, 400);
      assert.equal((await call(base, 'DELETE', { path: '/test', confirmPath: '/wrong', recursive: true })).status, 400);
      assert.equal((await call(base, 'PATCH', { path: '/test', name: '../target' })).status, 400);
      assert.equal(calls.length, before);
      assert.equal((await call('/api/accounts', 'POST', { large: 'x'.repeat(9000) })).status, 413);
    });
    await t.test('uploads exact binary bytes over the old JSON limit, to a Unicode path, and supports empty files', async () => {
      const bytes = Uint8Array.from({ length: 20000 }, (_, i) => i % 256), path = '/data/home/指定目录/a &?#%.bin';
      const result = await upload(base, path, bytes, '&parents=true');
      assert.equal(result.status, 201); assert.equal(result.body.sha256, hash(bytes)); assert.equal(result.body.size, bytes.length);
      assert.deepEqual(stored.get(path), bytes); assert.equal(result.body.secret, undefined);
      assert.equal(calls.at(-1)!.url.searchParams.get('parents'), 'true');
      assert.equal(calls.at(-1)!.url.searchParams.get('path'), path);
      assert.equal((await upload(base, '/data/home/empty', '')).status, 201);
      assert.equal(stored.get('/data/home/empty')!.length, 0);
    });
    await t.test('existing targets require explicit overwrite and rejected uploads leave original bytes intact', async () => {
      const before = receivedBytes;
      assert.equal((await upload(base, '/data/home/empty', 'changed')).body.error.code, 'file_exists');
      assert.equal(receivedBytes, before); assert.equal(stored.get('/data/home/empty')!.length, 0);
      assert.equal((await upload(base, '/data/home/empty', 'changed', '&overwrite=true')).status, 200);
      assert.equal(new TextDecoder().decode(stored.get('/data/home/empty')), 'changed');
    });
    await t.test('enforces upload limits for declared and streamed sizes, and rejects truncated request bodies', async () => {
      let before = calls.length;
      assert.equal((await upload(base, '/large', 'x', '', { 'Content-Length': String(maxUploadBytes + 1) })).status, 413);
      assert.equal(calls.length, before);
      // Reuse one 1 MiB buffer so the producer does not retain a 96 MiB body.
      const chunk = new Uint8Array(1024 * 1024); let chunks = 0;
      const huge = new ReadableStream<Uint8Array>({ pull(c) { if (++chunks > 96) c.close(); else c.enqueue(chunk); } });
      assert.equal((await upload(base, '/large', huge)).status, 413); assert.equal(stored.has('/large'), false);
      assert.equal((await upload(base, '/partial', 'short', '', { 'Content-Length': '10' })).status, 502);
      assert.equal(stored.has('/partial'), false);
      const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.error(new Error('interrupted')); } });
      assert.equal((await upload(base, '/broken', broken)).status, 502); assert.equal(stored.has('/broken'), false);
    });
    await t.test('lost or invalid upload replies do not report success or repeat writes automatically', async () => {
      loseWrite = true; const before = calls.filter(c => c.method === 'PUT').length;
      assert.equal((await upload(base, '/lost', 'saved')).status, 502);
      assert.equal(calls.filter(c => c.method === 'PUT').length, before + 1);
      assert.equal((await call(base + '?path=/lost')).body.content, 'saved');
      failure = 'wrong_size'; assert.equal((await upload(base, '/bad-reply', 'saved')).status, 502); failure = '';
    });
    await t.test('downloads remain byte-exact attachments and never expose upstream headers or execute HTML', async () => {
      const path = '/data/home/网页.html', bytes = new TextEncoder().encode('<script>alert(1)</script>\0中文'); stored.set(path, bytes);
      const r = await response(base + '/content?' + new URLSearchParams({ path }));
      assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'application/octet-stream');
      assert.match(r.headers.get('Content-Disposition')!, /attachment;.*filename\*=UTF-8''/);
      assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
      for (const header of ['X-API-Key', 'Set-Cookie', 'Location']) assert.equal(r.headers.has(header), false);
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
    });
    await t.test('file names are separate argv elements, rename never overwrites, and delete needs an exact path', async () => {
      const path = '/data/home/$(touch hacked); \' 空格';
      assert.equal((await call(base + '/directory', 'POST', { path, cmd: 'evil' })).status, 201);
      assert.deepEqual(calls.at(-1)!.body.argv, ['mkdir', '--', path]);
      assert.equal((await call(base, 'PATCH', { path, name: '--new `name`' })).status, 200);
      assert.deepEqual(calls.at(-1)!.body.argv, ['mv', '--no-clobber', '--no-target-directory', '--verbose', '--', path, '/data/home/--new `name`']);
      failure = 'skip'; assert.equal((await call(base, 'PATCH', { path, name: 'existing' })).body.error.code, 'file_exists'); failure = '';
      assert.equal((await call(base, 'DELETE', { path, confirmPath: path, recursive: false })).status, 200);
      assert.deepEqual(calls.at(-1)!.body.argv, ['rm', '--', path]);
      assert.equal((await call(base, 'DELETE', { path, confirmPath: path, recursive: true })).status, 200);
      assert.deepEqual(calls.at(-1)!.body.argv, ['rm', '--recursive', '--one-file-system', '--preserve-root=all', '--', path]);
      failure = 'command'; const failed = await call(base + '/directory', 'POST', { path }); assert.equal(failed.status, 409); assert.equal(JSON.stringify(failed).includes('ibk_'), false);
      failure = 'timeout'; const before = commands; assert.equal((await call(base + '/directory', 'POST', { path })).status, 504); assert.equal(commands, before + 1); failure = '';
    });
    await t.test('platform errors stay safe and disabled accounts cannot browse or upload', async () => {
      for (failure of ['scope', 'no_space', 'machine_not_running', 'redirect', 'html']) {
        const result = await call(base); assert.ok(result.status >= 400); assert.equal(JSON.stringify(result).includes('ibk_'), false);
      }
      failure = '';
      await call('/api/accounts/' + a.id, 'PATCH', { enabled: false }); const before = calls.length;
      assert.equal((await call(base)).status, 409); assert.equal((await upload(base, '/test', 'a')).status, 409); assert.equal(calls.length, before);
    });
  } finally { await mf.dispose(); }
});

test('real Workers runtime streams uploads and downloads through the authenticated proxy', async () => {
  const bundle = await build({ stdin: { contents: 'import {createApp} from "./src/worker/app.ts";export default createApp();', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.sql': 'text' } });
  const upstream = String.raw`let bytes;export default {async fetch(request){
    const u=new URL(request.url);if(u.origin!=='https://api.instabox.sh'||request.headers.has('Cookie')||request.headers.has('Origin')||request.headers.get('X-API-Key')!=='ibk_file_fixture')return new Response('bad proxy',{status:500});
    if(u.pathname==='/v1/me')return Response.json({userId:1});if(u.pathname==='/v1/machines')return Response.json({machines:[],nextCursor:null});
    if(request.method==='PUT'){bytes=new Uint8Array(await request.arrayBuffer());const hash=await crypto.subtle.digest('SHA-256',bytes);return Response.json({path:u.searchParams.get('path'),size:bytes.length,sha256:[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join(''),mode:'0644',created:true},{status:201});}
    if(u.pathname.endsWith('/content'))return new Response(bytes,{headers:{'Content-Type':'text/html','Content-Length':String(bytes.length)}});
    return Response.json({error:{code:'not_found'}},{status:404});}}`;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'panel', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-19', d1Databases: ['DB'], outboundService: 'upstream' },
    { name: 'upstream', modules: true, script: upstream, compatibilityDate: '2026-10-19' },
  ] }));
  try {
    const setup = await mf.dispatchFetch(origin + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ username: 'file-admin', password: 'file-test-password' }) });
    assert.equal(setup.status, 201); const cookie = setup.headers.get('Set-Cookie')!.split(';')[0];
    const account = await mf.dispatchFetch(origin + '/api/accounts', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ label: 'File', apiKey: 'ibk_file_fixture' }) }).then(r => r.json()) as any;
    const url = origin + '/api/accounts/' + account.account.id + '/machines/m_file/files/content?path=/data/home/binary.bin';
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 7 }, (_, i) => i % 256);
    const result = await mf.dispatchFetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: bytes });
    assert.equal(result.status, 201); assert.equal((await result.json() as any).sha256, hash(bytes));
    const download = await mf.dispatchFetch(url, { headers: { Cookie: cookie } });
    assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await mf.dispatchFetch(url)).status, 401);
  } finally { await mf.dispose(); }
});
