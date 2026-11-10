import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp, type Env } from '../src/worker/app';
import { automationDataKey } from '../src/worker/automation';
import { checkBoxKeepalive } from '../src/worker/box-keepalive';
import type { Fetcher } from '../src/worker/instabox';

const secret = Buffer.alloc(32, 11).toString('base64');
const base = 'https://panel.test';
const originHeaders = { 'Origin': base, 'Content-Type': 'application/json', 'X-Panel-Request': '1' };
const apiKey = 'cb_test_' + 'a'.repeat(48);

test('box panel stores the key encrypted, lists boxes, and runs keepalive through MCP', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-10-19', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    const calls: { tool: string; args: Record<string, unknown>; auth: string }[] = [];
    let revoked = false;
    const fetcher: Fetcher = async (input, init = {}) => {
      assert.equal(new URL(String(input)).origin, 'https://mcp.box.simular.ai');
      const request = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ tool: request.params.name, args: request.params.arguments, auth: new Headers(init.headers).get('Authorization') || '' });
      if (revoked) return Response.json({ error: { code: -32000, message: 'unauthorized' } }, { status: 401 });
      if (request.params.name === 'box_list')
        return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { boxes: [
          { box_id: 'cb-main', name: 'main', state: 'running', image: 'sbxdesk:v15', view_url: 'https://box.simular.ai/box/cb-main/live' },
          { box_id: 'cb-work', name: 'work', state: 'hibernated', image: 'sbxdesk:v15', view_url: 'https://box.simular.ai/box/cb-work/live' },
        ] } } });
      if (request.params.name === 'box_ensure')
        return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { box_id: request.params.arguments.box, state: 'running', operation_id: '' } } });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } });
    };
    const app = createApp({ fetcher, authenticate: async () => ({ username: 'owner', key: secret }) });
    const env = { DB: db, KEY_ENCRYPTION_SECRET: secret, ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
    async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = originHeaders) {
      const response = await app.fetch(new Request(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
      return { status: response.status, body: await response.json() as any };
    }

    await t.test('writes require the panel CSRF headers', async () => {
      const r = await call('/api/box', 'PUT', { apiKey }, { 'Origin': base, 'Content-Type': 'application/json' });
      assert.equal(r.status, 403);
      assert.equal(calls.length, 0);
    });
    await t.test('invalid key format is rejected before any upstream call', async () => {
      const r = await call('/api/box', 'PUT', { apiKey: 'ibk_wrong' });
      assert.equal(r.status, 400);
      assert.equal(calls.length, 0);
    });
    await t.test('a valid key is verified, encrypted at rest, and never returned', async () => {
      const r = await call('/api/box', 'PUT', { label: '我的 box', apiKey });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.configured, true);
      assert.equal(r.body.label, '我的 box');
      assert.deepEqual(r.body.boxes.map((box: any) => box.boxId), ['cb-main', 'cb-work']);
      assert.equal(JSON.stringify(r.body).includes(apiKey), false);
      assert.equal(calls[0].tool, 'box_list');
      assert.equal(calls[0].auth, 'Bearer ' + apiKey);
      const stored = await db.prepare('SELECT * FROM insb_box_account WHERE id=1').first<any>();
      assert.notEqual(stored.key_ciphertext, apiKey);
      assert.ok(stored.key_iv);
      assert.equal(stored.key_suffix, apiKey.slice(-4));
    });
    await t.test('keepalive policies reuse the shared schedule validation and cap', async () => {
      const invalid = await call('/api/box/keepalive/cb-main', 'PUT', { name: 'main', mode: 'windows', timezone: 'Asia/Shanghai', windows: [{ start: '09:00', end: '09:00' }] });
      assert.equal(invalid.status, 400);
      const missing = await call('/api/box/keepalive/cb-missing', 'PUT', { name: 'missing', mode: 'always', timezone: 'Asia/Shanghai', windows: [] });
      assert.equal(missing.status, 404);
      const saved = await call('/api/box/keepalive/cb-main', 'PUT', { name: 'main', mode: 'always', timezone: 'Asia/Shanghai', windows: [] });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.policies[0].mode, 'always');
      const work = await call('/api/box/keepalive/cb-work', 'PUT', { name: 'work', mode: 'always', timezone: 'Asia/Shanghai', windows: [] });
      assert.equal(work.status, 200);
      assert.equal(work.body.policies.length, 2);
    });
    await t.test('the scheduled task wakes boxes and records the result', async () => {
      const dataKey = await automationDataKey(env);
      calls.length = 0;
      await checkBoxKeepalive(env, dataKey, fetcher);
      assert.deepEqual(calls.map(call => call.tool), ['box_ensure', 'box_ensure']);
      assert.deepEqual(calls.map(call => call.args.box).sort(), ['cb-main', 'cb-work']);
      const row = await db.prepare('SELECT * FROM insb_box_keepalive WHERE box_id=?').bind('cb-main').first<any>();
      assert.equal(row.last_state, 'running');
      assert.equal(row.last_result, '运行正常');
      assert.ok(row.last_checked_at);
    });
    await t.test('a revoked key is reported without breaking the page', async () => {
      revoked = true;
      const overview = await call('/api/box');
      assert.equal(overview.status, 200);
      assert.equal(overview.body.configured, true);
      assert.ok(overview.body.error);
      calls.length = 0;
      await checkBoxKeepalive(env, await automationDataKey(env), fetcher);
      assert.equal(calls.length, 2);
      const row = await db.prepare('SELECT * FROM insb_box_keepalive WHERE box_id=?').bind('cb-main').first<any>();
      assert.equal(row.last_result, '保活失败');
      assert.ok(row.last_error);
      revoked = false;
    });
    await t.test('turning keepalive off stops scheduled calls', async () => {
      await call('/api/box/keepalive/cb-main', 'PUT', { name: 'main', mode: 'off', timezone: 'Asia/Shanghai', windows: [] });
      calls.length = 0;
      await checkBoxKeepalive(env, await automationDataKey(env), fetcher);
      assert.deepEqual(calls.map(call => call.tool), ['box_ensure']);
      assert.equal(calls[0].args.box, 'cb-work');
    });
    await t.test('removing the connection erases the key and every policy', async () => {
      const r = await call('/api/box', 'DELETE', {});
      assert.equal(r.status, 200);
      assert.equal((await call('/api/box')).body.configured, false);
      assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_box_account').first<any>()).total, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_box_keepalive').first<any>()).total, 0);
    });
  } finally { await mf.dispose(); }
});
