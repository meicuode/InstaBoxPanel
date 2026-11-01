import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function checkPortViews(page, output) {
  await page.getByRole('button', { name: '查看 development 端口转发', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'development · 端口转发', exact: true });
  await modal.getByText('暂无公开端口', { exact: true }).waitFor();
  await modal.getByRole('button', { name: '发布端口', exact: true }).click();
  await modal.getByLabel('端口号', { exact: true }).fill('5901');
  await modal.getByRole('button', { name: '确认发布', exact: true }).click();
  await modal.getByText('5901 和 6768 是平台保留端口，不能公开。', { exact: true }).waitFor();
  await modal.getByLabel('端口号', { exact: true }).fill('3000');
  await modal.getByLabel('端口名称（可选）', { exact: true }).fill('开发预览');
  await modal.getByRole('button', { name: '确认发布', exact: true }).click();
  const card = modal.locator('.port-card'); await card.getByText('开发预览', { exact: true }).waitFor();
  const url = await card.locator('a').getAttribute('href');
  assert.ok(url.startsWith('https://')); assert.equal(await card.locator('a').getAttribute('rel'), 'noopener noreferrer');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedPort = value; } } }));
  await modal.getByRole('button', { name: '复制端口 3000 地址', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copiedPort), url);
  await modal.getByRole('button', { name: '修改端口 3000 名称', exact: true }).click();
  assert.equal(await modal.getByLabel('端口号', { exact: true }).isDisabled(), true);
  const name = '<img src=x onerror=alert(1)>';
  await modal.getByLabel('端口名称（可选）', { exact: true }).fill(name);
  await modal.getByRole('button', { name: '保存名称', exact: true }).click();
  await card.getByText(name, { exact: true }).waitFor();
  assert.equal(await card.locator('img').count(), 0); assert.equal(await card.locator('a').getAttribute('href'), url);
  await page.screenshot({ path: path.join(output, 'ports-desktop.png') });
  const viewport = page.viewportSize(); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok((await modal.boundingBox()).width <= 390);
  assert.equal(await modal.evaluate(e => e.scrollWidth <= e.clientWidth + 1), true, 'port modal fits mobile width');
  await page.screenshot({ path: path.join(output, 'ports-mobile.png') });
  await modal.getByRole('button', { name: '取消端口 3000 转发', exact: true }).click();
  await modal.getByRole('button', { name: '保留转发', exact: true }).click(); assert.equal(await card.count(), 1);
  await modal.getByRole('button', { name: '取消端口 3000 转发', exact: true }).click();
  await modal.getByRole('button', { name: '确认取消转发', exact: true }).click();
  await modal.getByText('暂无公开端口', { exact: true }).waitFor();
  await modal.getByRole('button', { name: '关闭', exact: true }).click(); await page.setViewportSize(viewport);
  await page.getByRole('button', { name: '查看 development 详情', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '端口', exact: true }).click();
  await modal.getByText('暂无公开端口', { exact: true }).waitFor();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看 browser-agent 端口转发', exact: true }).click();
  const paused = page.getByRole('dialog', { name: 'browser-agent · 端口转发', exact: true });
  await paused.getByText('暂无公开端口', { exact: true }).waitFor();
  assert.equal(await paused.getByRole('button', { name: '发布端口', exact: true }).isDisabled(), false);
  await paused.getByText(/机器当前未运行/).waitFor(); await paused.getByRole('button', { name: '关闭', exact: true }).click();
}

export async function checkPortFailures(browser, root, output) {
  const base = 'http://127.0.0.1:4183';
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'test', '--host', '127.0.0.1', '--port', '4183', '--strictPort'], { cwd: root, env: { ...process.env, VITE_DEMO: 'false' }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let page, readError = false, loseWrite = false, scopeError = false, enabled = true, malformedUrl = false;
  const stamp = new Date().toISOString(), effects = [], pageErrors = [], ports = { a: [], b: [] };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(base)).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 150)); }
    assert.ok(ready, 'port browser fixture server did not start');
    page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (url.pathname === '/api/session') return send({ authenticated: true, setupRequired: false, username: 'test-admin', demo: false });
      if (url.pathname === '/api/accounts') return send({ accounts: ['a', 'b'].map(id => ({ id, label: 'Account ' + id, enabled: true, login: id, userId: id, email: '', keySuffix: 'test', createdAt: stamp, updatedAt: stamp })) });
      if (url.pathname === '/api/actions') return send({ actions: [] });
      if (url.pathname === '/api/keepalive') return send({ intervalMinutes: 1, maxMachines: 5, policies: [], lastRunAt: null });
      const machines = url.pathname.match(/^\/api\/accounts\/([ab])\/machines$/);
      if (machines) return send({ accountId: machines[1], checkedAt: new Date().toISOString(), machines: [{ id: 'm_ports', name: 'ports-test', orgId: 'org_ports', state: 'running', operationId: null, revision: 1, spec: { vcpus: 2, memMiB: 4096 }, runtime: { ready: true }, autoSuspendAfterSeconds: 600, createdAt: stamp, updatedAt: stamp }] });
      const match = url.pathname.match(/^\/api\/accounts\/([ab])\/machines\/m_ports\/ports(?:\/(\d+))?$/);
      if (!match) return send({ error: { code: 'not_found', message: url.pathname } }, 404);
      const id = match[1];
      if (method === 'GET') return readError ? send({ error: { code: 'unavailable', message: '无法读取端口' } }, 503) : send({ enabled, ports: ports[id].map(p => ({ ...p, url: malformedUrl ? 'javascript:alert(1)' : p.url })) });
      const body = request.postDataJSON(); effects.push({ id, method, body });
      if (scopeError) return send({ error: { code: 'insufficient_scope', message: '修改需要 machines:write' } }, 422);
      if (method === 'POST') {
        let port = ports[id].find(p => p.port === body.port);
        if (!port) { port = { id: id + '_' + body.port, machineId: 'm_ports', port: body.port, url: 'https://preview-' + id + '-' + body.port + '.example.test', createdAt: stamp }; ports[id].push(port); }
        port.name = body.name;
        if (loseWrite) { loseWrite = false; return route.abort('failed'); }
        return send({ port });
      }
      assert.equal(method, 'DELETE'); assert.equal(body.confirmPort, Number(match[2]));
      const existing = ports[id].find(p => p.port === body.confirmPort); assert.equal(body.portId, existing.id);
      ports[id] = ports[id].filter(p => p !== existing);
      if (loseWrite) { loseWrite = false; return route.abort('failed'); }
      return send({ ok: true });
    });
    await page.goto(base); await page.getByRole('button', { name: '查看 ports-test 端口转发', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'ports-test · 端口转发', exact: true });
    const button = name => modal.getByRole('button', { name, exact: true });
    const accountSelect = modal.getByLabel('端口操作账号', { exact: true });
    if (await accountSelect.inputValue() !== 'a') await accountSelect.selectOption('a');
    await modal.getByText('暂无公开端口', { exact: true }).waitFor(); await button('发布端口').click();
    const nameInput = modal.getByLabel('端口名称（可选）', { exact: true });
    await modal.getByLabel('端口号', { exact: true }).fill('3000'); await nameInput.fill('preview'); scopeError = true;
    await button('确认发布').click(); await modal.getByText('修改需要 machines:write', { exact: true }).waitFor(); await button('刷新端口').click();
    assert.equal(await nameInput.isDisabled(), false); assert.equal(await modal.getByText('修改需要 machines:write', { exact: true }).isVisible(), true);
    scopeError = false; loseWrite = true; await button('确认发布').click();
    await modal.getByText(/提交结果尚未确认/).waitFor(); await modal.locator('.port-card').getByText('preview', { exact: true }).waitFor();
    assert.equal(effects.length, 2); assert.equal(await modal.getByText('端口已公开。', { exact: true }).count(), 0); await button('取消').click();
    readError = true; await button('刷新端口').click(); await modal.getByText(/无法读取端口/).waitFor();
    assert.equal(await button('发布端口').isDisabled(), true); assert.equal(await button('取消端口 3000 转发').isDisabled(), true);
    readError = false; malformedUrl = true; await button('刷新端口').click(); await modal.getByText('访问地址暂不可用', { exact: true }).waitFor(); assert.equal(await modal.locator('a').count(), 0); malformedUrl = false;
    await modal.getByLabel('端口操作账号', { exact: true }).selectOption('b'); await modal.getByText('暂无公开端口', { exact: true }).waitFor(); assert.equal(await modal.locator('.port-card').count(), 0);
    await modal.getByLabel('端口操作账号', { exact: true }).selectOption('a'); await modal.locator('.port-card').waitFor();
    enabled = false; await button('刷新端口').click(); await modal.getByText(/平台尚未启用公网端口服务/).waitFor(); assert.equal(await button('发布端口').isDisabled(), true);
    enabled = true; await button('刷新端口').click(); await button('取消端口 3000 转发').click(); loseWrite = true;
    await button('确认取消转发').click(); await modal.getByText(/提交结果尚未确认/).waitFor(); await modal.getByText('暂无公开端口', { exact: true }).waitFor();
    assert.equal(effects.length, 3); assert.equal(await modal.getByText('端口转发已取消。', { exact: true }).count(), 0); await button('保留转发').click();
    ports.a = Array.from({ length: 16 }, (_, i) => ({ id: 'a_' + i, machineId: 'm_ports', port: 4000 + i, name: 'service ' + i, url: 'https://preview-' + i + '.example.test', createdAt: stamp }));
    await button('刷新端口').click(); await modal.getByText('已公开 16 / 16 个端口', { exact: true }).waitFor();
    assert.equal(await button('发布端口').isDisabled(), true); assert.equal(await button('修改端口 4000 名称').isDisabled(), false);
    await page.screenshot({ path: path.join(output, 'ports-errors-and-quota.png') }); assert.deepEqual(pageErrors, []);
  } catch (error) { if (page) await page.screenshot({ path: path.join(output, 'ports-failure.png') }).catch(() => {}); throw error; }
  finally { await context.close(); child.kill(); }
}
