import initialSql from '../../migrations/0001_initial.sql';
import authSql from '../../migrations/0002_auth.sql';
import keepaliveSql from '../../migrations/0003_keepalive.sql';
import telegramSql from '../../migrations/0004_telegram.sql';
import automationKeysSql from '../../migrations/0005_automation_keys.sql';
import actionSourcesSql from '../../migrations/0006_action_sources.sql';
import telegramButtonsSql from '../../migrations/0007_telegram_buttons.sql';
import snapshotRequestsSql from '../../migrations/0008_snapshot_requests.sql';
import boxPanelSql from '../../migrations/0009_box_panel.sql';
import { PanelError } from './errors';

const migrations = [
  { name: '0001_initial.sql', sql: initialSql },
  { name: '0002_auth.sql', sql: authSql },
  { name: '0003_keepalive.sql', sql: keepaliveSql },
  { name: '0004_telegram.sql', sql: telegramSql },
  { name: '0005_automation_keys.sql', sql: automationKeysSql },
  { name: '0006_action_sources.sql', sql: actionSourcesSql },
  { name: '0007_telegram_buttons.sql', sql: telegramButtonsSql },
  { name: '0008_snapshot_requests.sql', sql: snapshotRequestsSql },
  { name: '0009_box_panel.sql', sql: boxPanelSql },
];
const initialization = new WeakMap<object, Promise<void>>();

export function database(env: { DB?: D1Database }): D1Database {
  if (!env.DB || typeof env.DB.prepare !== 'function')
    throw new PanelError(503, 'database_configuration', '请在 Cloudflare 配置页面将 D1 数据库绑定为 DB，然后重试。');
  return env.DB;
}

export function isMissingPanelTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (/\bno such table:\s*(?:main\.)?insb_[a-z0-9_]+\b/i.test(String(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function initialize(db: D1Database): Promise<void> {
  // D1 batch is transactional; every statement also tolerates simultaneous first visits.
  const statements = [db.prepare(`CREATE TABLE IF NOT EXISTS insb_d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`)];
  for (const migration of migrations) {
    for (const statement of migration.sql.split(';').map(value => value.trim()).filter(Boolean)) {
      if (!/^PRAGMA foreign_keys\b/i.test(statement)) statements.push(db.prepare(statement));
    }
    statements.push(db.prepare('INSERT OR IGNORE INTO insb_d1_migrations (name) VALUES (?)').bind(migration.name));
  }
  await db.batch(statements);
}

export async function ensureDatabase(db: D1Database): Promise<void> {
  try {
    // Probe each required table, including partial initialization, without scanning rows.
    await db.prepare(`SELECT
      (SELECT id FROM insb_admin WHERE id = 1) AS admin_id,
      (SELECT id FROM insb_accounts LIMIT 1) AS account_id,
      (SELECT id FROM insb_actions LIMIT 1) AS action_id,
      (SELECT action_id FROM insb_action_sources LIMIT 1) AS action_source_id,
      (SELECT token_hash FROM insb_sessions LIMIT 1) AS session_id,
      (SELECT bucket FROM insb_login_limits LIMIT 1) AS rate_id,
      (SELECT machine_id FROM insb_keepalive LIMIT 1) AS keepalive_id,
      (SELECT id FROM insb_scheduler LIMIT 1) AS scheduler_id,
      (SELECT id FROM insb_automation LIMIT 1) AS automation_id,
      (SELECT id FROM insb_automation_keys LIMIT 1) AS automation_key_id,
      (SELECT id FROM insb_telegram LIMIT 1) AS telegram_id,
      (SELECT update_id FROM insb_telegram_updates LIMIT 1) AS telegram_update_id,
      (SELECT token FROM insb_telegram_buttons LIMIT 1) AS telegram_button_id,
      (SELECT machine_id FROM insb_machine_watch LIMIT 1) AS watch_id,
      (SELECT id FROM insb_snapshot_requests LIMIT 1) AS snapshot_request_id,
      (SELECT id FROM insb_box_account LIMIT 1) AS box_account_id,
      (SELECT box_id FROM insb_box_keepalive LIMIT 1) AS box_keepalive_id,
      (SELECT name FROM insb_d1_migrations LIMIT 1) AS migration`).first();
  } catch (error) {
    if (!isMissingPanelTable(error)) throw error;
    let pending = initialization.get(db);
    if (!pending) {
      pending = initialize(db);
      initialization.set(db, pending);
    }
    try { await pending; }
    finally { if (initialization.get(db) === pending) initialization.delete(db); }
  }
}
