import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ActionType } from '../shared/types';
import { encryptKey, decryptKey } from './crypto';
import { accountView, actionRow, actionView, type AccountRow, type ActionRow } from './db';
import { PanelError, safeUpstreamMessage } from './errors';
import { Instabox, type Fetcher } from './instabox';
import { database, ensureDatabase } from './schema';
import { applyOperation, createAction } from './actions';
import { keepaliveOverview, saveKeepalive } from './keepalive';
import { boxOverview, removeBoxAccount, saveBoxAccount, saveBoxKeepalive } from './box-keepalive';
import { telegramStatus, saveTelegram, removeTelegram, telegramWebhook } from './telegram';
import { authenticateSession, sessionStatus, setupAdmin, loginAdmin, logoutAdmin, type Identity } from './session';
import { registerDesktopRoutes } from './desktop';
import { registerSnapshotRoutes } from './snapshots';
import { registerPortRoutes } from './ports';
import { isFileUpload, registerFileRoutes } from './files';

export interface Env { DB: D1Database; KEY_ENCRYPTION_SECRET?: string; AUTOMATION_SECRET?: string; ASSETS: FetcherBinding }
interface FetcherBinding { fetch(request: Request): Promise<Response> }
interface Dependencies {
  fetcher?: Fetcher;
  authenticate?: (request: Request, env: Env) => Promise<Identity>;
}
const now = () => new Date().toISOString();
const activeStates = ['submitting', 'queued', 'running', 'unknown'];
function validId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new PanelError(400, 'invalid_id', '标识格式无效。');
  return id;
}
function label(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60)
    throw new PanelError(400, 'invalid_label', '账号别名需要 1 到 60 个字符。');
  return value.trim();
}
function apiKey(value: unknown) {
  if (typeof value !== 'string' || !/^ibk_[!-~]{4,508}$/.test(value.trim()))
    throw new PanelError(400, 'invalid_api_key_format', '请输入以 ibk_ 开头的完整 API Key。');
  return value.trim();
}
async function account(db: D1Database, id: string, allowDisabled = false): Promise<AccountRow> {
  const row = await db.prepare('SELECT * FROM insb_accounts WHERE id = ? AND deleted_at IS NULL').bind(validId(id)).first<AccountRow>();
  if (!row) throw new PanelError(404, 'account_not_found', '账号不存在或已被移除。');
  if (!allowDisabled && !row.enabled) throw new PanelError(409, 'account_disabled', '请先启用这个账号。');
  return row;
}
async function action(db: D1Database, id: string): Promise<ActionRow> {
  const row = await actionRow(db, validId(id));
  if (!row) throw new PanelError(404, 'action_not_found', '操作记录不存在。');
  return row;
}

export function createApp(deps: Dependencies = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { identity: Identity } }>();
  async function client(identity: Identity, row: AccountRow) {
    const key = await decryptKey(row.key_ciphertext, row.key_iv, identity.key, row.id);
    return new Instabox(key, deps.fetcher);
  }
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    c.header('Cache-Control', 'no-store');
    if (!c.req.path.startsWith('/api/')) { await next(); return; }
    if (new URL(c.req.url).protocol !== 'https:')
      throw new PanelError(400, 'https_required', '管理员登录和机器管理需要 HTTPS，请使用 Cloudflare 的 HTTPS 地址。');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !(c.req.method === 'POST' && c.req.path === '/api/telegram/webhook')) {
      if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('X-Panel-Request') !== '1')
        throw new PanelError(403, 'csrf_rejected', '请求来源验证失败，请从面板重新操作。');
      if (isFileUpload(c.req.method, c.req.path)) {
        if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream')
          throw new PanelError(415, 'binary_required', '上传必须使用二进制文件内容。');
      } else if (!c.req.header('Content-Type')?.startsWith('application/json'))
        throw new PanelError(415, 'json_required', '请求必须使用 JSON。');
    }
    await next();
  });
  const jsonLimit = bodyLimit({ maxSize: 8192, onError: c => c.json({ error: { code: 'body_too_large', message: '请求内容过大。' } }, 413) });
  app.use('/api/*', (c, next) => isFileUpload(c.req.method, c.req.path) ? next() : jsonLimit(c, next));
  async function jsonBody(request: Request): Promise<unknown> {
    try { return await request.json(); }
    catch { throw new PanelError(400, 'invalid_json', '请求 JSON 无效。'); }
  }
  app.get('/api/session', async c => c.json(await sessionStatus(c.env, c.req.raw)));
  app.post('/api/auth/setup', async c => {
    const result = await setupAdmin(c.env, c.req.raw, await jsonBody(c.req.raw));
    c.header('Set-Cookie', result.cookie); return c.json(result.session, 201);
  });
  app.post('/api/auth/login', async c => {
    const result = await loginAdmin(c.env, c.req.raw, await jsonBody(c.req.raw));
    c.header('Set-Cookie', result.cookie); return c.json(result.session);
  });
  app.post('/api/auth/logout', async c => {
    c.header('Set-Cookie', await logoutAdmin(database(c.env), c.req.raw));
    return c.json({ ok: true });
  });
  app.post('/api/telegram/webhook', c => telegramWebhook(c.env, c.req.raw, deps.fetcher));
  app.use('/api/*', async (c, next) => {
    const db = database(c.env);
    const identity = deps.authenticate ? await deps.authenticate(c.req.raw, c.env) : await authenticateSession(c.req.raw, db);
    c.set('identity', identity);
    await next();
  });
  app.get('/api/accounts', async c => {
    const result = await c.env.DB.prepare('SELECT * FROM insb_accounts WHERE deleted_at IS NULL ORDER BY created_at').all<AccountRow>();
    return c.json({ accounts: result.results.map(accountView) });
  });
  app.get('/api/keepalive', async c => c.json(await keepaliveOverview(c.env, c.get('identity').key)));
  app.get('/api/telegram', async c => c.json(await telegramStatus(c.env, c.get('identity').key)));
  app.put('/api/telegram', async c => c.json(await saveTelegram(c.env, await jsonBody(c.req.raw), new URL(c.req.url).origin, c.get('identity').key, deps.fetcher)));
  app.delete('/api/telegram', async c => c.json(await removeTelegram(c.env, deps.fetcher)));
  app.get('/api/box', async c => c.json(await boxOverview(c.env, c.get('identity').key, deps.fetcher)));
  app.put('/api/box', async c => c.json(await saveBoxAccount(c.env, await jsonBody(c.req.raw), c.get('identity').key, deps.fetcher)));
  app.delete('/api/box', async c => c.json(await removeBoxAccount(c.env)));
  app.put('/api/box/keepalive/:boxId', async c =>
    c.json(await saveBoxKeepalive(c.env, c.req.param('boxId'), await jsonBody(c.req.raw), c.get('identity').key, deps.fetcher)));
  app.put('/api/accounts/:id/machines/:machineId/keepalive', async c => {
    const row = await account(c.env.DB, c.req.param('id'), true);
    return c.json(await saveKeepalive(c.env, row, validId(c.req.param('machineId')), await jsonBody(c.req.raw), c.get('identity').key, deps.fetcher));
  });
  app.post('/api/accounts', async c => {
    const body = await c.req.json().catch(() => { throw new PanelError(400, 'invalid_json', '请求 JSON 无效。'); });
    const name = label(body?.label);
    const key = apiKey(body?.apiKey);
    const id = crypto.randomUUID();
    const encrypted = await encryptKey(key, c.get('identity').key, id);
    const remote = new Instabox(key, deps.fetcher);
    const me = await remote.me();
    await remote.list(); // Checks read access without waking or changing a machine.
    const existing = await c.env.DB.prepare('SELECT id FROM insb_accounts WHERE instabox_user_id = ? AND deleted_at IS NULL').bind(me.userId).first();
    if (existing) throw new PanelError(409, 'duplicate_account', '这个 InstaBox 账号已经接入，请在原账号中替换 Key。');
    const timestamp = now();
    try {
      await c.env.DB.prepare('INSERT INTO insb_accounts (id,label,instabox_user_id,login,email,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(id, name, me.userId, me.login, me.email, encrypted.ciphertext, encrypted.iv, key.slice(-4), timestamp, timestamp).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new PanelError(409, 'duplicate_account', '这个 InstaBox 账号已经接入。');
      throw error;
    }
    return c.json({ account: accountView(await account(c.env.DB, id)) }, 201);
  });
  app.patch('/api/accounts/:id', async c => {
    const row = await account(c.env.DB, c.req.param('id'), true);
    const body = await c.req.json().catch(() => null);
    if (!body || Array.isArray(body)) throw new PanelError(400, 'invalid_json', '请求 JSON 无效。');
    const name = body.label === undefined ? row.label : label(body.label);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new PanelError(400, 'invalid_enabled', '启用状态无效。');
    let ciphertext = row.key_ciphertext, iv = row.key_iv, suffix = row.key_suffix;
    let login = row.login, email = row.email;
    if (body.apiKey !== undefined) {
      const key = apiKey(body.apiKey);
      const remote = new Instabox(key, deps.fetcher);
      const me = await remote.me();
      if (me.userId !== row.instabox_user_id) throw new PanelError(409, 'account_mismatch', '新的 Key 属于另一个 InstaBox 账号，请单独添加。');
      await remote.list();
      const encrypted = await encryptKey(key, c.get('identity').key, row.id);
      ciphertext = encrypted.ciphertext; iv = encrypted.iv; suffix = key.slice(-4); login = me.login; email = me.email;
    }
    await c.env.DB.prepare('UPDATE insb_accounts SET label=?,enabled=?,key_ciphertext=?,key_iv=?,key_suffix=?,login=?,email=?,updated_at=? WHERE id=?')
      .bind(name, body.enabled === undefined ? row.enabled : Number(body.enabled), ciphertext, iv, suffix, login, email, now(), row.id).run();
    return c.json({ account: accountView(await account(c.env.DB, row.id, true)) });
  });
  app.delete('/api/accounts/:id', async c => {
    await ensureDatabase(c.env.DB);
    const row = await account(c.env.DB, c.req.param('id'), true);
    const snapshotPending = await c.env.DB.prepare("SELECT id FROM insb_snapshot_requests WHERE account_id=? AND state IN ('submitting','pending','unknown') LIMIT 1").bind(row.id).first();
    if (snapshotPending) throw new PanelError(409,'pending_snapshots','请先在快照窗口确认未完成的快照请求，再移除账号。');
    const pending = await c.env.DB.prepare("SELECT id FROM insb_actions WHERE account_id = ? AND state IN ('submitting','queued','running','unknown') LIMIT 1").bind(row.id).first();
    if (pending) throw new PanelError(409, 'pending_actions', '请先等待或确认这个账号的未完成操作，再移除账号。');
    // Keep the audit trail, erase the credential, never call DELETE on InstaBox.
    await ensureDatabase(c.env.DB);
    const removed = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE insb_accounts SET deleted_at=?,updated_at=?,enabled=0,key_ciphertext='',key_iv='',key_suffix=''
        WHERE id=? AND deleted_at IS NULL AND NOT EXISTS
        (SELECT id FROM insb_actions WHERE account_id=? AND state IN ('submitting','queued','running','unknown')) AND NOT EXISTS
        (SELECT id FROM insb_snapshot_requests WHERE account_id=? AND state IN ('submitting','pending','unknown'))`).bind(now(), now(), row.id, row.id, row.id),
      c.env.DB.prepare(`UPDATE insb_keepalive SET mode='off',version=version+1,last_result='账号已移除',last_error=''
        WHERE account_id=? AND EXISTS(SELECT id FROM insb_accounts WHERE id=? AND deleted_at IS NOT NULL)`).bind(row.id, row.id),
      c.env.DB.prepare('DELETE FROM insb_machine_watch WHERE account_id=? AND EXISTS(SELECT id FROM insb_accounts WHERE id=? AND deleted_at IS NOT NULL)').bind(row.id, row.id),
    ]);
    if (!removed[0].meta.changes) throw new PanelError(409, 'pending_actions', '账号有新提交的未完成操作，请先确认结果后再移除。');
    return c.json({ ok: true });
  });
  app.get('/api/accounts/:id/machines', async c => {
    const row = await account(c.env.DB, c.req.param('id'));
    const machines = await (await client(c.get('identity'), row)).list();
    return c.json({ accountId: row.id, machines, checkedAt: now() });
  });
  app.get('/api/accounts/:id/machines/:machineId', async c => {
    const row = await account(c.env.DB, c.req.param('id'));
    return c.json({ machine: await (await client(c.get('identity'), row)).machine(validId(c.req.param('machineId'))), checkedAt: now() });
  });
  app.get('/api/accounts/:id/machines/:machineId/terminal', async c => {
    if (c.req.header('Origin') !== new URL(c.req.url).origin)
      throw new PanelError(403, 'csrf_rejected', '终端连接来源无效。');
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket')
      throw new PanelError(426, 'websocket_required', '终端需要 WebSocket 连接。');
    const row = await account(c.env.DB, c.req.param('id'));
    const machineId = validId(c.req.param('machineId'));
    const dimension = (value: string | undefined, fallback: number, min: number, max: number) => {
      if (value === undefined) return fallback;
      if (!/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max)
        throw new PanelError(400, 'invalid_terminal_size', '终端窗口尺寸无效。');
      return Number(value);
    };
    const cols = dimension(c.req.query('cols'), 80, 10, 1000);
    const rows = dimension(c.req.query('rows'), 24, 4, 500);
    const key = await decryptKey(row.key_ciphertext, row.key_iv, c.get('identity').key, row.id);
    const query = new URLSearchParams({ cols: String(cols), rows: String(rows), session: 'panel', wake: '0' });
    let response: Response;
    try {
      response = await (deps.fetcher || fetch)('https://api.instabox.sh/v1/machines/' + encodeURIComponent(machineId) + '/terminal?' + query, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Upgrade: 'websocket', 'X-API-Key': key },
      });
    } catch { throw new PanelError(502, 'terminal_unavailable', '暂时无法连接远端终端。', true); }
    if (response.status !== 101 || !response.webSocket) {
      const data = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const rawCode = data?.error?.code;
      const code = rawCode && /^[a-z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'terminal_unavailable';
      throw new PanelError(502, code, safeUpstreamMessage(code), true);
    }
    // Let workerd proxy binary PTY frames and text resize/control frames unchanged.
    // Browser cookies, Access tokens, and Origin never go to the upstream API.
    return new Response(null, { status: 101, webSocket: response.webSocket });
  });
  app.get('/api/actions', async c => {
    await ensureDatabase(c.env.DB);
    // Include all unresolved actions, even when more recent completed actions exist.
    const rows = await c.env.DB.prepare(`SELECT a.*,s.source FROM (
      SELECT * FROM insb_actions WHERE state IN ('submitting','queued','running','unknown')
      UNION SELECT * FROM (SELECT * FROM insb_actions ORDER BY created_at DESC LIMIT 50)
      ) a LEFT JOIN insb_action_sources s ON s.action_id=a.id ORDER BY a.created_at DESC`).all<ActionRow>();
    return c.json({ actions: rows.results.map(actionView) });
  });
  app.post('/api/accounts/:id/machines/:machineId/actions', async c => {
    await ensureDatabase(c.env.DB);
    const row = await account(c.env.DB, c.req.param('id'));
    const machineId = validId(c.req.param('machineId'));
    const body = await c.req.json().catch(() => null);
    if (!body || !['suspend', 'resume', 'start', 'stop'].includes(body.type) ||
        typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))
      throw new PanelError(400, 'invalid_action', '操作类型或请求标识无效。');
    const type = body.type as ActionType;
    let record = await actionRow(c.env.DB, body.requestId);
    if (record && (record.account_id !== row.id || record.machine_id !== machineId || record.type !== type))
      throw new PanelError(409, 'idempotency_conflict', '这个请求标识已经用于另一个操作。');
    if (record) {
      if (record.operation_id || ['succeeded', 'failed'].includes(record.state))
        return c.json({ action: actionView(record) }, 202);
      if (Date.now() - Date.parse(record.created_at) > 6 * 86400000)
        throw new PanelError(409, 'retry_window_expired', '原请求已超过安全重试期限，请先在官方控制台确认结果。');
      if (record.state === 'submitting' && Date.now() - Date.parse(record.updated_at) < 30000)
        return c.json({ action: actionView(record) }, 202);
    }
    const remote = await client(c.get('identity'), row);
    if (!record) {
      const machine = await remote.machine(machineId);
      if (type === 'stop' && machine.state === 'suspended')
        throw new PanelError(409, 'invalid_state', '暂停中的机器不能直接停止，请先恢复。');
      const result = await createAction(c.env.DB, row.id, machine, type, body.requestId, 'web');
      record = result.action;
      if (!result.created) return c.json({ action: actionView(record) }, 202);
    } else {
      const claimed = await c.env.DB.prepare("UPDATE insb_actions SET state='submitting',updated_at=?,error_code=NULL,error_message=NULL WHERE id=? AND operation_id IS NULL AND (state='unknown' OR (state='submitting' AND updated_at < ?))")
        .bind(now(), record.id, new Date(Date.now() - 30000).toISOString()).run();
      if (!claimed.meta.changes) return c.json({ action: actionView(await action(c.env.DB, record.id)) }, 202);
    }
    try {
      await applyOperation(c.env.DB, record, await remote.change(machineId, type, 'panel-' + record.id));
    } catch (error) {
      const e = error instanceof PanelError ? error : new PanelError(502, 'submission_uncertain', '操作结果尚未确认，请使用原请求重试。', true);
      const uncertain = e.status >= 500;
      await c.env.DB.prepare("UPDATE insb_actions SET state=?,error_code=?,error_message=?,updated_at=? WHERE id=? AND state='submitting'")
        .bind(uncertain ? 'unknown' : 'failed', e.code, e.message, now(), record.id).run();
    }
    return c.json({ action: actionView(await action(c.env.DB, record.id)) }, 202);
  });
  app.get('/api/actions/:id', async c => {
    await ensureDatabase(c.env.DB);
    const record = await action(c.env.DB, c.req.param('id'));
    if (record.operation_id && activeStates.includes(record.state)) {
      const row = await account(c.env.DB, record.account_id, true);
      const rawWait = c.req.query('wait') || '0';
      if (!/^\d{1,2}$/.test(rawWait) || Number(rawWait) > 25) throw new PanelError(400, 'invalid_wait', '等待时间需要是 0 到 25 秒。');
      await applyOperation(c.env.DB, record, await (await client(c.get('identity'), row)).operation(record.operation_id, Number(rawWait)));
    }
    return c.json({ action: actionView(await action(c.env.DB, record.id)) });
  });
  registerDesktopRoutes(app,{account,remote:client,fetcher:deps.fetcher});
  registerSnapshotRoutes(app,{account,remote:client,fetcher:deps.fetcher});
  registerPortRoutes(app,{account,remote:client});
  registerFileRoutes(app,{account,remote:client});
  app.all('/api/*', c => c.json({ error: { code: 'not_found', message: '接口不存在。' } }, 404));
  app.get('*', c => c.env.ASSETS.fetch(c.req.raw));
  app.onError((error, c) => {
    const e = error instanceof PanelError ? error : new PanelError(500, 'internal_error', '服务暂时不可用，请检查数据库迁移和部署配置。');
    // Intentionally do not log request bodies, credentials, SQL errors, or upstream text.
    return new Response(JSON.stringify({ error: { code: e.code, message: e.message, retryable: e.retryable } }), {
      status: e.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}) },
    });
  });
  return app;
}
