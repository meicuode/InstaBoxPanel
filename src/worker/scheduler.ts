import { automationDataKey, type AutomationEnv } from './automation';
import { checkKeepalive } from './keepalive';
import { checkBoxKeepalive } from './box-keepalive';
import { checkTelegramNotifications } from './telegram';
import { database, ensureDatabase } from './schema';
import { PanelError } from './errors';
import type { Fetcher } from './instabox';

export async function runAutomation(env: AutomationEnv, scheduledTime = Date.now(), fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<void> {
  if (!env.DB) return;
  const db = database(env);
  await ensureDatabase(db);
  if (!await db.prepare('SELECT id FROM insb_automation WHERE id=1').first()) return;
  const timestamp = Date.now(), tick = Math.floor(scheduledTime / 60000), token = crypto.randomUUID();
  const claim = await db.prepare('UPDATE insb_scheduler SET lease_token=?,lease_until=?,last_tick=? WHERE id=1 AND lease_until<=? AND last_tick<?')
    .bind(token, timestamp + 180000, tick, timestamp, tick).run();
  if (!claim.meta.changes) return;
  let requests = 0;
  const limitedFetch: Fetcher = (input, init) => {
    if (requests >= 35 || Date.now() - timestamp > 120000)
      throw new PanelError(503, 'automation_budget', '本轮自动化已达到请求或时间上限，将在下次继续。', true);
    requests++;
    return fetcher(input, init);
  };
  let notificationRequests = 0;
  const notificationFetch: Fetcher = (input, init) => {
    if (notificationRequests >= 25 || Date.now() - timestamp > 60000)
      throw new PanelError(503, 'automation_budget', '本轮通知检测已达到预算上限，将在下次继续；保活预算已预留。', true);
    notificationRequests++;
    return limitedFetch(input, init);
  };
  try {
    const dataKey = await automationDataKey(env);
    try { await checkTelegramNotifications(env, dataKey, notificationFetch, tick); }
    finally {
      try { await checkBoxKeepalive(env, dataKey, limitedFetch); }
      finally { await checkKeepalive(env, dataKey, limitedFetch); }
    }
  } finally {
    await db.prepare('UPDATE insb_scheduler SET lease_until=0,last_run_at=? WHERE id=1 AND lease_token=?').bind(Date.now(), token).run();
  }
}
