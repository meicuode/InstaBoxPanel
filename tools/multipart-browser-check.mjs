import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export async function checkMultipartUploads(browser, root, output) {
  const site = 'http://127.0.0.1:4186', stamp = new Date().toISOString(), chunkSize = 16 * 1024 * 1024;
  const file = path.join(output, 'multipart-browser-100MiB.bin'), size = 100 * 1024 * 1024 + 37;
  const handle = await open(file, 'w'); await handle.truncate(size); await handle.write(Buffer.from('分片开头\0\xff'), 0, undefined, 0); await handle.write(Buffer.from('分片末尾\0\xfe'), 0, undefined, size - 20); await handle.close();
  const expected = createHash('sha256'); for await (const bytes of createReadStream(file)) expected.update(bytes); const expectedHash = expected.digest('hex');
  const sessions = new Map(), saved = new Map(), transfers = [], errors = [];
  let failOnce = true, holdMerge = true, holdPart = false, releasePart, merges = 0;
  const server = createServer(async (request, response) => {
    const send = (value, status = 200) => { if (response.destroyed) return; response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': site, 'Access-Control-Allow-Credentials': 'true' }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, site), method = request.method;
      if (url.pathname === '/api/session') return send({ authenticated: true, setupRequired: false, username: 'upload-admin', demo: false });
      if (url.pathname === '/api/accounts') return send({ accounts: [{ id: 'a', label: '分片测试账号', enabled: true, login: 'a', userId: 'a', email: '', keySuffix: 'test', createdAt: stamp, updatedAt: stamp }] });
      if (url.pathname === '/api/actions') return send({ actions: [] });
      if (url.pathname === '/api/keepalive') return send({ intervalMinutes: 1, maxMachines: 5, policies: [], lastRunAt: null });
      if (url.pathname === '/api/accounts/a/machines') return send({ accountId: 'a', checkedAt: new Date().toISOString(), machines: [{ id: 'm_large', name: 'large-files', orgId: 'org_a', state: 'running', operationId: null, revision: 1, spec: { vcpus: 2, memMiB: 4096 }, runtime: { ready: true }, autoSuspendAfterSeconds: 600, createdAt: stamp, updatedAt: stamp }] });
      const base = '/api/accounts/a/machines/m_large/files';
      if (url.pathname === base && method === 'GET') return send({ path: '/data/home', type: 'dir', size: 0, mode: 'drwxr-xr-x', modTime: stamp, content: '', binary: false, truncated: false,
        entries: [...saved].map(([p, data]) => ({ name: p.split('/').at(-1), type: 'file', size: data.size, mode: '-rw-r--r--', modTime: stamp })) });
      const match = url.pathname.slice(base.length).match(/^\/uploads(?:\/([0-9a-f-]+)(?:\/(status|finish|parts)(?:\/(\d+))?)?)?$/);
      assert.ok(match, 'Only multipart uploads should be used for this large file');
      const buffers = []; for await (const chunk of request) buffers.push(chunk); const bytes = Buffer.concat(buffers);
      const body = method === 'PUT' ? undefined : bytes.length ? JSON.parse(bytes.toString()) : {};
      const id = match[1] || body.uploadId;
      if (!match[1]) {
        assert.equal(body.size, size); assert.ok(!sessions.has(id)); sessions.set(id, { path: body.path, size: body.size, state: 'uploading', parts: new Map(), hashes: new Map() });
      }
      const session = sessions.get(id); assert.ok(session);
      if (match[1]) assert.equal(method === 'PUT' ? request.headers['x-upload-ticket'] : body.ticket, 'ticket-' + id);
      if (method === 'DELETE') { sessions.delete(id); return send({ ok: true }); }
      const index = Number(match[3]);
      if (method === 'PUT') {
        assert.equal(request.headers['content-type'], 'application/octet-stream'); assert.equal(request.headers['x-panel-request'], '1');
        assert.ok(bytes.length <= chunkSize); assert.equal(bytes.length, Math.min(chunkSize, size - index * chunkSize));
        const hash = createHash('sha256').update(bytes).digest('hex'); assert.equal(hash, request.headers['x-chunk-sha256']);
        transfers.push({ id, index, bytes: bytes.length }); session.parts.set(index, bytes); session.hashes.set(index, hash);
        if (holdPart) await new Promise(resolve => { releasePart = resolve; });
        if (index === 2 && failOnce) { failOnce = false; return send({ error: { code: 'upstream_unreachable', message: '模拟分片回复丢失' } }, 502); }
      }
      if (match[2] === 'finish') { assert.equal(session.parts.size, Math.ceil(size / chunkSize)); session.state = 'merging'; merges++; }
      if (match[2] === 'status' && session.state === 'merging' && !holdMerge) {
        const hash = createHash('sha256'); for (let i = 0; i < Math.ceil(size / chunkSize); i++) hash.update(session.parts.get(i));
        session.result = { path: session.path, size, sha256: hash.digest('hex'), mode: '644', created: true }; session.state = 'complete'; saved.set(session.path, session.result);
      }
      send({ uploadId: id, ticket: 'ticket-' + id, chunkSize, path: session.path, state: session.state,
        parts: [...session.hashes].map(([index, sha256]) => ({ index, sha256 })), ...(session.result ? { result: session.result } : {}) });
    } catch (e) { errors.push(e.message); send({ error: { code: 'fixture_error', message: e.message } }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const upstream = 'http://127.0.0.1:' + server.address().port;
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'test', '--host', '127.0.0.1', '--port', '4186', '--strictPort'], { cwd: root, env: { ...process.env, VITE_DEMO: 'false' }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); let page;
  try {
    let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(site)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 150)); } assert.ok(ready);
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', route => { const u = new URL(route.request().url()); return route.continue({ url: upstream + u.pathname + u.search }); });
    await page.goto(site);
    const modal = page.getByRole('dialog', { name: 'large-files · 文件管理', exact: true });
    const button = name => modal.getByRole('button', { name, exact: true });
    const select = async () => { await page.getByRole('button', { name: '管理 large-files 文件', exact: true }).click(); await modal.getByText('此目录为空', { exact: true }).waitFor(); await button('上传文件').click(); await modal.getByLabel('选择文件', { exact: true }).setInputFiles(file); };
    await select(); await button('开始上传（1）').click(); await modal.getByText('模拟分片回复丢失', { exact: true }).waitFor();
    assert.deepEqual(transfers.map(t => t.index), [0, 1, 2]); assert.equal(saved.size, 0);
    await page.reload(); await select(); await modal.getByRole('heading', { name: '保留的上传任务', exact: true }).waitFor();
    await button('开始上传（1）').click(); await modal.getByText('正在服务器合并并校验，请稍候…', { exact: true }).waitFor({ timeout: 60000 });
    assert.deepEqual(transfers.map(t => t.index), [0, 1, 2, 3, 4, 5, 6]); assert.equal(merges, 1); assert.equal(saved.size, 0);
    assert.equal(await modal.getByText('上传完成', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'multipart-merging.png') });
    holdMerge = false; await modal.getByText('上传完成', { exact: true }).waitFor();
    assert.equal([...saved.values()][0].sha256, expectedHash); assert.equal(sessions.size, 0);
    assert.equal(await modal.locator('.file-retained').count(), 0);
    await button('重新准备上传').click(); await modal.getByLabel('目标目录', { exact: true }).fill('/data/home/discard'); holdPart = true;
    await button('开始上传（1）').click();
    for (let i = 0; i < 200 && !releasePart; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(releasePart);
    await button('取消上传').click(); await modal.getByText(/已暂停等待，已保存的分片会保留/).waitFor();
    holdPart = false; releasePart(); releasePart = undefined;
    await button('清理分片').click(); await modal.locator('.file-retained').waitFor({ state: 'detached' }); assert.equal(sessions.size, 0); assert.equal(saved.size, 1);
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await modal.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
    await page.screenshot({ path: path.join(output, 'multipart-mobile.png') });
    assert.deepEqual(errors, []);
    await writeFile(path.join(output, 'multipart-browser-report.json'), JSON.stringify({ bytes: size, sha256: expectedHash, chunks: transfers, merges, errors }, null, 2));
  } catch (e) { if (page) await page.screenshot({ path: path.join(output, 'multipart-failure.png'), fullPage: true }).catch(() => {}); throw e; }
  finally { releasePart?.(); await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); child.kill(); }
}
