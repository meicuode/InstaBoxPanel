import type { Account, Action, Machine, ActionType } from '../shared/types';
import { ApiError } from './api';
import { validateSchedule, type KeepaliveOverview } from '../shared/keepalive';
import { BOX_KEEPALIVE_INTERVAL_MINUTES, BOX_KEEPALIVE_MAX_BOXES, type BoxKeepalivePolicy, type BoxOverview, type SimularBox } from '../shared/box';
import type { TelegramStatus } from '../shared/telegram';
import { demoResources } from './demo-resources';
import { demoPorts } from './demo-ports';
import { demoFiles } from './demo-files';
let telegram: TelegramStatus = { tokenRequired: true, enabled: false, username: '', chatId: '', notifyOffline: false, lastError: '' };
const keepalive: KeepaliveOverview = { intervalMinutes: 1, maxMachines: 5, policies: [], lastRunAt: null };
let boxConfigured = false, boxLabel = '', boxKeySuffix = '';
let boxPolicies: BoxKeepalivePolicy[] = [];
const demoBoxes: SimularBox[] = [
  { boxId: 'cb-demo-main', name: 'main', state: 'running', image: 'sbxdesk:v15', viewUrl: 'https://box.simular.ai/box/cb-demo-main/live' },
  { boxId: 'cb-demo-work', name: 'work', state: 'hibernated', image: 'sbxdesk:v15', viewUrl: 'https://box.simular.ai/box/cb-demo-work/live' },
];
function boxOverview(): BoxOverview {
  return { configured: boxConfigured, label: boxLabel, keySuffix: boxKeySuffix, enabled: boxConfigured,
    intervalMinutes: BOX_KEEPALIVE_INTERVAL_MINUTES, maxBoxes: BOX_KEEPALIVE_MAX_BOXES,
    boxes: boxConfigured ? copy(demoBoxes) : [], policies: copy(boxPolicies),
    lastRunAt: boxConfigured ? Date.now() - 30000 : null, error: '' };
}
const stamp = () => new Date().toISOString();
const accounts: Account[] = [
  { id: 'demo-main', label: '主账号', userId: '1001', login: 'darre', email: 'darre@example.com', keySuffix: '4f9a', enabled: true, createdAt: stamp(), updatedAt: stamp() },
  { id: 'demo-lab', label: '实验室', userId: '1002', login: 'darre-lab', email: 'lab@example.com', keySuffix: '82bc', enabled: true, createdAt: stamp(), updatedAt: stamp() },
];
function machine(id: string, name: string, state: Machine['state']): Machine {
  return { id, name, state, orgId: 'org_personal', operationId: null, revision: 1, autoSuspendAfterSeconds: 1800,
    createdAt: stamp(), updatedAt: stamp(), spec: { vcpus: 4, memMiB: 8192 }, runtime: { ready: state === 'running' } };
}
const machines: Record<string, Machine[]> = {
  'demo-main': [machine('m_development', 'development', 'running'), machine('m_browser', 'browser-agent', 'suspended'), machine('m_notes', 'personal-workspace', 'running')],
  'demo-lab': [machine('m_experiment', 'experiment', 'stopped'), machine('m_preview', 'web-preview', 'suspended')],
};
const actions: Action[] = [];
const failedAccounts = new Set<string>();
const copy = <T,>(value: T): T => structuredClone(value);
let administrator: { username: string; password: string } | null = null;
let authenticated = false;
const session = () => ({ username: authenticated ? administrator!.username : '', authenticated, setupRequired: !administrator, demo: true });
export async function demoRequest(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, 180));
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = new URL(path, 'http://demo.local');
  const method = options.method || 'GET';
  const body = options.body as Record<string, any> | undefined;
  if (url.pathname === '/api/session') return session();
  if (url.pathname === '/api/auth/setup' && method === 'POST') {
    if (administrator) throw new ApiError('already_initialized', '管理员已经设置，请直接登录。', 409);
    if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(body?.username || '') || typeof body?.password !== 'string' || body.password.length < 12)
      throw new ApiError('invalid_credentials_format', '请使用至少 3 个字符的账号和至少 12 个字符的示例密码。', 400);
    administrator = { username: body.username.toLowerCase(), password: body.password }; authenticated = true; return session();
  }
  if (url.pathname === '/api/auth/login' && method === 'POST') {
    if (!administrator) throw new ApiError('setup_required', '请先设置管理员账号。', 409);
    if (body?.username?.toLowerCase() !== administrator.username || body?.password !== administrator.password)
      throw new ApiError('invalid_credentials', '账号或密码不正确。', 401);
    authenticated = true; return session();
  }
  if (url.pathname === '/api/auth/logout' && method === 'POST') { authenticated = false; return { ok: true }; }
  if (!authenticated) throw new ApiError('authentication_required', '请先登录管理员账号。', 401);
  const files = await demoFiles(url, method, options.body, accounts, machines);
  if (files !== undefined) return files;
  const ports = demoPorts(url.pathname,method,body,accounts,machines);
  if (ports !== undefined) return ports;
  const resource = demoResources(url.pathname,method,body,accounts,machines);
  if(resource!==undefined)return resource;
  if (url.pathname === '/api/keepalive') return copy(keepalive);
  if (url.pathname === '/api/box') {
    if (method === 'PUT') {
      if (!String(body?.apiKey || '').startsWith('cb_demo_')) throw new ApiError('demo_key', '演示模式请使用示例密钥 cb_demo_example。');
      boxConfigured = true; boxLabel = body?.label || 'Simular box'; boxKeySuffix = String(body?.apiKey).slice(-4);
      return boxOverview();
    }
    if (method === 'DELETE') { boxConfigured = false; boxLabel = ''; boxKeySuffix = ''; boxPolicies = []; return { ok: true }; }
    return boxOverview();
  }
  const demoBoxKeepalive = url.pathname.match(/^\/api\/box\/keepalive\/([^/]+)$/);
  if (demoBoxKeepalive && method === 'PUT') {
    const policy = validateSchedule(body);
    const box = demoBoxes.find(item => item.boxId === demoBoxKeepalive[1]);
    if (!box) throw new ApiError('box_not_found', '这个 box 不在当前密钥的账号中。', 404);
    boxPolicies = boxPolicies.filter(item => item.boxId !== box.boxId);
    if (policy.mode !== 'off') boxPolicies.push({ ...policy, boxId: box.boxId, boxName: box.name, lastCheckedAt: Date.now() - 30000, lastState: 'running', lastResult: '演示模式不运行定时任务', lastError: '' });
    return boxOverview();
  }
  if (url.pathname === '/api/telegram') {
    if (method === 'PUT') telegram = { ...telegram, enabled: true, tokenRequired: false, username: 'instabox_demo_bot', chatId: body?.chatId || '', notifyOffline: Boolean(body?.notifyOffline) };
    if (method === 'DELETE') { telegram = { ...telegram, enabled: false, tokenRequired: true, username: '', chatId: '', notifyOffline: false }; return { ok: true, warning: '' }; }
    return copy(telegram);
  }
  const keepaliveMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/machines\/([^/]+)\/keepalive$/);
  if (keepaliveMatch && method === 'PUT') {
    const policy = validateSchedule(body);
    const machine = machines[keepaliveMatch[1]]?.find(item => item.id === keepaliveMatch[2]);
    if (!machine) throw new ApiError('not_found', '机器不存在。');
    keepalive.policies = keepalive.policies.filter(item => item.machineId !== machine.id);
    keepalive.policies.push({ ...policy, accountId: keepaliveMatch[1], machineId: machine.id, machineName: machine.name, lastCheckedAt: null, lastState: '', lastResult: '演示模式不运行定时任务', lastError: '' });
    return copy(keepalive);
  }
  if (url.pathname === '/api/accounts' && method === 'GET') return { accounts: copy(accounts) };
  if (url.pathname === '/api/accounts' && method === 'POST') {
    if (!body?.apiKey?.startsWith('ibk_demo_')) throw new ApiError('demo_key', '演示模式请使用示例密钥 ibk_demo_example。');
    const row: Account = { id: crypto.randomUUID(), label: body.label, userId: crypto.randomUUID(), login: 'demo-user', email: '', keySuffix: body.apiKey.slice(-4), enabled: true, createdAt: stamp(), updatedAt: stamp() };
    accounts.push(row); machines[row.id] = [];
    if (body.apiKey === 'ibk_demo_error') failedAccounts.add(row.id);
    return { account: copy(row) };
  }
  const a = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (a) {
    const row = accounts.find(x => x.id === a[1]);
    if (!row) throw new ApiError('not_found', '账号不存在。');
    if (method === 'PATCH') {
      if (body?.apiKey && !body.apiKey.startsWith('ibk_demo_')) throw new ApiError('demo_key', '演示模式请使用 ibk_demo_example。');
      if (body?.label) row.label = body.label;
      if (typeof body?.enabled === 'boolean') row.enabled = body.enabled;
      if (body?.apiKey) { row.keySuffix = body.apiKey.slice(-4); failedAccounts.delete(row.id); }
      return { account: copy(row) };
    }
    if (method === 'DELETE') { accounts.splice(accounts.indexOf(row), 1); return { ok: true }; }
  }
  const list = url.pathname.match(/^\/api\/accounts\/([^/]+)\/machines$/);
  if (list) {
    if (failedAccounts.has(list[1])) throw new ApiError('api_key_revoked', '这个账号的 API Key 已撤销，请替换。');
    return { accountId: list[1], machines: copy(machines[list[1]] || []), checkedAt: stamp() };
  }
  if (url.pathname === '/api/actions') return { actions: copy(actions) };
  const change = url.pathname.match(/^\/api\/accounts\/([^/]+)\/machines\/([^/]+)\/actions$/);
  if (change && body) {
    const old = actions.find(x => x.id === body.requestId);
    if (old) return { action: copy(old) };
    const m = machines[change[1]]?.find(x => x.id === change[2]);
    if (!m) throw new ApiError('not_found', '机器不存在。');
    const type = body.type as ActionType;
    const record: Action = { id: body.requestId, accountId: change[1], machineId: m.id, machineName: m.name, type,
      source: 'web', state: 'running', operationId: 'op_' + body.requestId, phase: 'waiting_ready', errorCode: null, errorMessage: null,
      processesPreserved: null, createdAt: stamp(), updatedAt: stamp() };
    actions.unshift(record);
    m.state = { suspend: 'suspending', resume: 'resuming', start: 'starting', stop: 'stopping' }[type] as Machine['state'];
    m.operationId = record.operationId;
    setTimeout(() => {
      m.state = type === 'suspend' ? 'suspended' : type === 'stop' ? 'stopped' : 'running';
      m.runtime.ready = m.state === 'running'; m.operationId = null; m.revision++; m.updatedAt = stamp();
      record.state = 'succeeded'; record.phase = ''; record.updatedAt = stamp();
      record.processesPreserved = type === 'resume' ? true : null;
    }, 1400);
    return { action: copy(record) };
  }
  const getAction = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (getAction) return { action: copy(actions.find(x => x.id === getAction[1])) };
  throw new ApiError('not_found', '演示接口不存在。');
}
