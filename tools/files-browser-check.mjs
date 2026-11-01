import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export async function checkFileViews(page, output) {
  await page.getByRole('button', { name: '管理 development 文件', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'development · 文件管理', exact: true });
  const button = name => modal.getByRole('button', { name, exact: true });
  const go = async value => { await modal.getByLabel('文件路径', { exact: true }).fill(value); await button('前往').click(); await page.waitForFunction(() => !document.querySelector('.file-loading')); };
  await modal.locator('[data-file="README.md"]').waitFor();
  await button('新建目录').click(); await modal.getByLabel('目录名称', { exact: true }).fill('测试目录'); await button('创建目录').click();
  await modal.locator('[data-file="测试目录"]').waitFor();
  await button('重命名 测试目录').click(); await modal.getByLabel('新名称', { exact: true }).fill('中文 空格'); await button('保存名称').click();
  await modal.locator('[data-file="中文 空格"]').waitFor();
  await button('上传文件').click(); await modal.getByLabel('目标目录', { exact: true }).fill('/data/home/中文 空格/子目录');
  await modal.getByLabel('自动创建不存在的目录', { exact: true }).check();
  const text = '# 标题\n<svg onload=alert(1)>原样预览</svg>\n', binary = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
  await modal.getByLabel('选择文件', { exact: true }).setInputFiles([
    { name: '你好.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    { name: 'bytes.bin', mimeType: 'application/octet-stream', buffer: binary },
  ]);
  await button('开始上传（2）').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.file-upload-status')].filter(e => e.textContent.includes('上传完成')).length === 2);
  await page.waitForFunction(() => !document.querySelector('.file-loading'));
  await page.screenshot({ path: path.join(output, 'files-desktop.png') });
  await go('/data/home/中文 空格/子目录'); await modal.locator('[data-file="你好.txt"]').waitFor();
  await button('收起上传').click(); await modal.locator('[data-file="你好.txt"] .file-open').click();
  await modal.locator('.file-preview pre').waitFor(); assert.equal(await modal.locator('pre').textContent(), text); assert.equal(await modal.locator('.file-preview svg[onload]').count(), 0);
  await button('上一级目录').click(); await modal.locator('[data-file="bytes.bin"]').waitFor();
  const downloading = page.waitForEvent('download'); await button('下载 bytes.bin').click(); const download = await downloading;
  assert.equal(download.suggestedFilename(), 'bytes.bin'); const destination = path.join(output, 'files-downloaded.bin'); await download.saveAs(destination); assert.deepEqual(await readFile(destination), binary);
  await button('上传文件').click(); await button('重新准备上传').click();
  await modal.getByLabel('目标目录', { exact: true }).fill('/data/home/中文 空格/子目录');
  await modal.getByLabel('选择文件', { exact: true }).setInputFiles({ name: '你好.txt', mimeType: 'text/plain', buffer: Buffer.from('覆盖后的内容') });
  await button('开始上传（1）').click(); await button('确认覆盖').waitFor();
  await button('确认覆盖').click(); await modal.locator('.file-upload-status').getByText('上传完成', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.file-loading'));
  const original = page.viewportSize(); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok((await modal.boundingBox()).width <= 390); assert.ok(await modal.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
  await page.screenshot({ path: path.join(output, 'files-mobile.png') }); await page.setViewportSize(original);
  await button('收起上传').click(); await modal.locator('[data-file="你好.txt"] .file-open').click(); await modal.getByText('覆盖后的内容', { exact: true }).waitFor();
  await go('/data/home'); await button('删除 中文 空格').click();
  assert.equal(await button('确认删除').isDisabled(), true); await modal.getByLabel('输入完整路径确认', { exact: true }).fill('中文 空格'); assert.equal(await button('确认删除').isDisabled(), true);
  await modal.getByLabel('输入完整路径确认', { exact: true }).fill('/data/home/中文 空格'); await button('确认删除').click();
  await modal.locator('[data-file="中文 空格"]').waitFor({ state: 'detached' }); await button('关闭').click();
  await page.getByRole('button', { name: '查看 development 详情', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '文件', exact: true }).click();
  await modal.locator('[data-file="README.md"]').waitFor(); await button('关闭').click();
}

export async function checkFileFailures(browser, root, output) {
  const base = 'http://127.0.0.1:4184';
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'test', '--host', '127.0.0.1', '--port', '4184', '--strictPort'], { cwd: root, env: { ...process.env, VITE_DEMO: 'false' }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const stamp = new Date().toISOString(), libraries = { a: new Map(), b: new Map() }, writes = [], errors = [];
  let page, readError = false, mode = '', release;
  // Real HTTP uploads are necessary: intercepted fulfill() responses suppress native XHR upload progress.
  const uploadServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, base), id = url.pathname.split('/')[3], files = libraries[id], target = url.searchParams.get('path');
      assert.equal(request.headers['x-panel-request'], '1'); assert.equal(request.headers['content-type'], 'application/octet-stream');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), overwrite = url.searchParams.get('overwrite') === 'true'; writes.push({ id, target, bytes, overwrite });
      const send = (json, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' }); response.end(JSON.stringify(json)); };
      if (mode === 'auth') return send({ error: { code: 'authentication_required', message: '登录已过期，请重新登录。' } }, 401);
      if (mode === 'scope') return send({ error: { code: 'insufficient_scope', message: '文件管理需要 machines:write 权限。' } }, 422);
      if (files.has(target) && !overwrite) return send({ error: { code: 'file_exists', message: '目标已存在，请确认覆盖这个文件。' } }, 409);
      if (mode === 'hold') await new Promise(resolve => { release = resolve; });
      files.set(target, bytes);
      if (mode === 'lost') return send({ error: { code: 'upstream_unreachable', message: '上传结果尚未确认，请刷新目录核对。' } }, 502);
      send({ path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: '0644', created: true }, 201);
    } catch (e) { errors.push(e.message); response.destroy(); }
  });
  await new Promise(resolve => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadOrigin = 'http://127.0.0.1:' + uploadServer.address().port;
  try {
    let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(base)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 150)); }
    assert.ok(ready, 'file fixture did not start');
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (url.pathname === '/api/session') return send({ authenticated: true, setupRequired: false, username: 'test-admin', demo: false });
      if (url.pathname === '/api/accounts') return send({ accounts: ['a', 'b'].map(id => ({ id, label: 'Account ' + id, enabled: true, login: id, userId: id, email: '', keySuffix: 'test', createdAt: stamp, updatedAt: stamp })) });
      if (url.pathname === '/api/actions') return send({ actions: [] });
      if (url.pathname === '/api/keepalive') return send({ intervalMinutes: 1, maxMachines: 5, policies: [], lastRunAt: null });
      const machines = url.pathname.match(/^\/api\/accounts\/([ab])\/machines$/);
      if (machines) return send({ accountId: machines[1], checkedAt: new Date().toISOString(), machines: [{ id: 'm_files', name: 'files-test', orgId: 'org_files', state: 'running', operationId: null, revision: 1, spec: { vcpus: 2, memMiB: 4096 }, runtime: { ready: true }, autoSuspendAfterSeconds: 600, createdAt: stamp, updatedAt: stamp }] });
      const match = url.pathname.match(/^\/api\/accounts\/([ab])\/machines\/m_files\/files(\/content)?$/);
      if (!match) return send({ error: { code: 'not_found', message: url.pathname } }, 404);
      const id = match[1], files = libraries[id], target = url.searchParams.get('path');
      if (method === 'PUT') return mode === 'network' ? route.abort('failed') : route.continue({ url: uploadOrigin + url.pathname + url.search });
      if (method === 'GET') {
        if (readError) return send({ error: { code: 'unavailable', message: '文件读取暂时失败' } }, 503);
        const file = files.get(target), meta = { size: file?.length || 0, mode: '-rw-r--r--', modTime: stamp, binary: false, truncated: false };
        return send({ ...meta, path: target, type: file ? 'file' : 'dir', content: file?.toString() || '', entries: [...files].map(([p, b]) => ({ ...meta, name: p.split('/').at(-1), type: 'file', size: b.length })) });
      }
      return send({ error: { code: 'not_found', message: 'Unknown method' } }, 404);
    });
    await page.goto(base); await page.getByRole('button', { name: '管理 files-test 文件', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'files-test · 文件管理', exact: true });
    const button = name => modal.getByRole('button', { name, exact: true });
    await modal.getByLabel('文件操作账号', { exact: true }).selectOption('a');
    await modal.getByText('此目录为空', { exact: true }).waitFor();
    await button('上传文件').click();
    const bytes = Buffer.from(Array.from({ length: 20000 }, (_, i) => i % 256));
    async function choose(name) { await modal.getByLabel('选择文件', { exact: true }).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes }); }
    mode = 'hold'; await choose('raw.bin'); await button('开始上传（1）').click();
    await page.waitForFunction(() => document.querySelector('.file-upload-status')?.textContent.includes('等待服务器确认'));
    assert.equal(await modal.getByLabel('目标目录', { exact: true }).isDisabled(), true); assert.equal(await modal.getByLabel('文件操作账号', { exact: true }).isDisabled(), true);
    await button('关闭').click(); assert.equal(await modal.isVisible(), true); assert.equal(await modal.getByText('上传完成', { exact: true }).count(), 0);
    assert.deepEqual(writes[0].bytes, bytes); mode = ''; release(); release = undefined;
    await modal.getByText('上传完成', { exact: true }).waitFor();
    await choose('raw.bin'); await button('开始上传（1）').click(); await button('确认覆盖').waitFor(); assert.equal(writes.at(-1).overwrite, false);
    await button('确认覆盖').click(); await modal.getByText('上传完成', { exact: true }).waitFor(); assert.equal(writes.at(-1).overwrite, true);
    mode = 'lost'; await choose('lost.bin'); await button('开始上传（1）').click(); await modal.getByText('上传结果尚未确认，请刷新目录核对。', { exact: true }).waitFor();
    await modal.locator('[data-file="lost.bin"]').waitFor(); assert.equal(await modal.getByText('上传完成', { exact: true }).count(), 0); assert.equal(writes.length, 4); mode = '';
    readError = true; await button('刷新目录').click(); await modal.getByText(/文件读取暂时失败/).waitFor(); assert.equal(await button('上传文件').isDisabled(), true); assert.equal(await button('重新上传').isDisabled(), true);
    readError = false; await button('刷新目录').click(); await page.waitForFunction(() => !document.querySelector('.file-loading'));
    mode = 'network'; await choose('network.bin'); await button('开始上传（1）').click(); await modal.getByText('连接中断，上传结果尚未确认。', { exact: true }).waitFor(); assert.equal(writes.length, 4);
    mode = 'scope'; await choose('scope.bin'); await button('开始上传（1）').click(); await modal.getByText('文件管理需要 machines:write 权限。', { exact: true }).waitFor(); mode = '';
    await modal.getByLabel('文件操作账号', { exact: true }).selectOption('b'); await modal.getByText('此目录为空', { exact: true }).waitFor(); assert.equal(await modal.locator('.file-upload-item').count(), 0);
    await button('上传文件').click(); mode = 'hold';
    await modal.getByLabel('选择文件', { exact: true }).setInputFiles([{ name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: bytes }, { name: 'later.bin', mimeType: 'application/octet-stream', buffer: bytes }]);
    await button('开始上传（2）').click(); await page.waitForFunction(() => document.querySelector('.file-upload-status')?.textContent.includes('等待服务器确认')); const count = writes.length;
    await button('取消上传').click(); await modal.getByText('上传已取消，请刷新目录核对文件是否已保存。', { exact: true }).waitFor();
    mode = ''; release?.(); release = undefined; assert.equal(writes.length, count); assert.equal(await modal.getByText('尚未上传', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(output, 'files-errors.png') });
    mode = 'auth'; await choose('session.bin'); await button('开始上传（1）').click(); await page.getByRole('heading', { name: '登录私人控制台', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } catch (e) { if (page) await page.screenshot({ path: path.join(output, 'files-failure.png'), fullPage: true }).catch(() => {}); throw e; }
  finally { release?.(); await context.close(); uploadServer.closeAllConnections(); await new Promise(resolve => uploadServer.close(resolve)); child.kill(); }
}
