import { BOX_KEEPALIVE_INTERVAL_MINUTES, BOX_KEEPALIVE_MAX_BOXES, validateBoxId, validateBoxKey, type BoxKeepalivePolicy, type BoxOverview, type SimularBox } from '../shared/box';
import { inKeepaliveWindow, validateSchedule, type KeepaliveMode, type TimeWindow } from '../shared/keepalive';
import { enableAutomation, type AutomationEnv } from './automation';
import { ensureBox, listBoxes } from './box';
import { decryptKey, encryptKey } from './crypto';
import { PanelError } from './errors';
import type { Fetcher } from './instabox';
import { database, ensureDatabase } from './schema';

export type BoxEnv = AutomationEnv;
interface BoxAccountRow {
  label: string; key_ciphertext: string; key_iv: string; key_suffix: string; enabled: number;
}
interface BoxPolicyRow {
  box_id: string; box_name: string; mode: KeepaliveMode; timezone: string; windows_json: string;
  version: number; last_checked_at: number | null; last_state: string; last_result: string; last_error: string;
}
function policyView(row: BoxPolicyRow): BoxKeepalivePolicy {
  return { boxId: row.box_id, boxName: row.box_name, mode: row.mode, timezone: row.timezone,
    windows: JSON.parse(row.windows_json) as TimeWindow[], lastCheckedAt: row.last_checked_at,
    lastState: row.last_state, lastResult: row.last_result, lastError: row.last_error };
}
async function lastRunAt(env: BoxEnv): Promise<number | null> {
  const row = await database(env).prepare('SELECT last_run_at FROM insb_scheduler WHERE id=1').first<{ last_run_at: number | null }>();
  return row?.last_run_at ?? null;
}
export async function boxOverview(env: BoxEnv, dataKey: string, fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<BoxOverview> {
  const db = database(env);
  await ensureDatabase(db);
  const account = await db.prepare('SELECT * FROM insb_box_account WHERE id=1').first<BoxAccountRow>();
  const policies = await db.prepare('SELECT * FROM insb_box_keepalive ORDER BY box_name').all<BoxPolicyRow>();
  let boxes: SimularBox[] = [], error = '';
  if (account) {
    try {
      boxes = await listBoxes(await decryptKey(account.key_ciphertext, account.key_iv, dataKey, 'box:1'), fetcher);
    } catch (failure) {
      error = failure instanceof PanelError ? failure.message : 'box 状态暂时无法读取，请稍后重试。';
    }
  }
  return { configured: Boolean(account), label: account?.label || '', keySuffix: account?.key_suffix || '',
    enabled: Boolean(account?.enabled), intervalMinutes: BOX_KEEPALIVE_INTERVAL_MINUTES,
    maxBoxes: BOX_KEEPALIVE_MAX_BOXES, boxes, policies: policies.results.map(policyView),
    lastRunAt: await lastRunAt(env), error };
}
export async function saveBoxAccount(env: BoxEnv, value: unknown, dataKey: string, fetcher?: Fetcher): Promise<BoxOverview> {
  const body = value as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PanelError(400, 'invalid_box', '请求内容无效。');
  let apiKey: string;
  try { apiKey = validateBoxKey(body.apiKey); }
  catch (error) { throw new PanelError(400, 'invalid_box_key', (error as Error).message); }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Simular box';
  if (label.length > 60) throw new PanelError(400, 'invalid_label', '名称需要 1 到 60 个字符。');
  await listBoxes(apiKey, fetcher || ((input, init) => fetch(input, init))); // Validates the key before storing it.
  await enableAutomation(env, dataKey);
  const encrypted = await encryptKey(apiKey, dataKey, 'box:1');
  const timestamp = new Date().toISOString();
  await database(env).prepare(`INSERT INTO insb_box_account (id,label,key_ciphertext,key_iv,key_suffix,enabled,created_at,updated_at)
    VALUES (1,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,key_ciphertext=excluded.key_ciphertext,
    key_iv=excluded.key_iv,key_suffix=excluded.key_suffix,enabled=1,updated_at=excluded.updated_at`)
    .bind(label, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), timestamp, timestamp).run();
  return boxOverview(env, dataKey, fetcher);
}
export async function removeBoxAccount(env: BoxEnv): Promise<{ ok: true }> {
  const db = database(env);
  await ensureDatabase(db);
  await db.batch([
    db.prepare('DELETE FROM insb_box_keepalive'),
    db.prepare('DELETE FROM insb_box_account'),
  ]);
  return { ok: true };
}
export async function saveBoxKeepalive(env: BoxEnv, boxId: string, value: unknown, dataKey: string, fetcher?: Fetcher): Promise<BoxOverview> {
  const db = database(env);
  await ensureDatabase(db);
  try { validateBoxId(boxId); }
  catch (error) { throw new PanelError(400, 'invalid_box_id', (error as Error).message); }
  let policy: ReturnType<typeof validateSchedule>;
  try { policy = validateSchedule(value); }
  catch (error) { throw new PanelError(400, 'invalid_keepalive', (error as Error).message); }
  const account = await db.prepare('SELECT * FROM insb_box_account WHERE id=1').first<BoxAccountRow>();
  if (!account) throw new PanelError(409, 'box_not_configured', '请先连接 box 密钥。');
  if (!account.enabled) throw new PanelError(409, 'box_disabled', '请先启用 box 连接。');
  const existing = await db.prepare('SELECT * FROM insb_box_keepalive WHERE box_id=?').bind(boxId).first<BoxPolicyRow>();
  if (policy.mode !== 'off') {
    const remote = fetcher || ((input, init) => fetch(input, init));
    const boxes = await listBoxes(await decryptKey(account.key_ciphertext, account.key_iv, dataKey, 'box:1'), remote);
    const box = boxes.find(item => item.boxId === boxId);
    if (!box) throw new PanelError(404, 'box_not_found', '这个 box 不在当前密钥的账号中。');
    const count = await db.prepare("SELECT COUNT(*) AS total FROM insb_box_keepalive WHERE mode<>'off' AND box_id<>?").bind(boxId).first<{ total: number }>();
    if (existing?.mode === 'off' || !existing) {
      if ((count?.total || 0) >= BOX_KEEPALIVE_MAX_BOXES)
        throw new PanelError(409, 'keepalive_limit', `最多同时保活 ${BOX_KEEPALIVE_MAX_BOXES} 台 box。`);
    }
    await enableAutomation(env, dataKey);
    await db.prepare(`INSERT INTO insb_box_keepalive (box_id,box_name,mode,timezone,windows_json,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(box_id) DO UPDATE SET box_name=excluded.box_name,mode=excluded.mode,
      timezone=excluded.timezone,windows_json=excluded.windows_json,version=insb_box_keepalive.version+1,
      last_error='',last_result='等待定时检查',updated_at=excluded.updated_at`)
      .bind(boxId, box.name || boxId, policy.mode, policy.timezone, JSON.stringify(policy.windows), new Date().toISOString()).run();
  } else if (existing) {
    await db.prepare("UPDATE insb_box_keepalive SET mode='off',version=version+1,last_error='',last_result='保活已关闭',updated_at=? WHERE box_id=?")
      .bind(new Date().toISOString(), boxId).run();
  }
  return boxOverview(env, dataKey, fetcher);
}
async function saveResult(db: D1Database, row: BoxPolicyRow, timestamp: number, state: string, result: string, error = '') {
  await db.prepare('UPDATE insb_box_keepalive SET last_checked_at=?,last_state=?,last_result=?,last_error=? WHERE box_id=? AND version=?')
    .bind(timestamp, state, result, error, row.box_id, row.version).run();
}
async function runPolicy(env: BoxEnv, row: BoxPolicyRow, apiKey: string, fetcher: Fetcher) {
  const timestamp = Date.now();
  if (!inKeepaliveWindow({ mode: row.mode, timezone: row.timezone, windows: JSON.parse(row.windows_json) as TimeWindow[] }, timestamp)) return;
  try {
    const result = await ensureBox(apiKey, row.box_id, fetcher);
    await saveResult(env.DB, row, timestamp, result.state, result.state === 'running' ? '运行正常' : '已提交唤醒');
  } catch (failure) {
    await saveResult(env.DB, row, timestamp, '', '保活失败', failure instanceof PanelError ? failure.message : '唤醒失败，请稍后重试。');
  }
}
export async function checkBoxKeepalive(env: BoxEnv, dataKey: string, fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<void> {
  const db = env.DB;
  const account = await db.prepare('SELECT * FROM insb_box_account WHERE id=1 AND enabled=1').first<BoxAccountRow>();
  if (!account) return;
  const policies = await db.prepare("SELECT * FROM insb_box_keepalive WHERE mode<>'off' ORDER BY box_id LIMIT ?")
    .bind(BOX_KEEPALIVE_MAX_BOXES).all<BoxPolicyRow>();
  if (!policies.results.length) return;
  let apiKey: string;
  try { apiKey = await decryptKey(account.key_ciphertext, account.key_iv, dataKey, 'box:1'); }
  catch (failure) {
    const message = failure instanceof PanelError ? failure.message : '无法解密 box 密钥，请重新填写。';
    for (const row of policies.results) await saveResult(db, row, Date.now(), '', '保活失败', message);
    return;
  }
  for (let offset = 0; offset < policies.results.length; offset += 2)
    await Promise.all(policies.results.slice(offset, offset + 2).map(row => runPolicy(env, row, apiKey, fetcher)));
}
