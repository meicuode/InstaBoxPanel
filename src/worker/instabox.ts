import type { Machine, MachineState } from '../shared/types';
import { machineStates } from '../shared/types';
import { PanelError, safeUpstreamMessage } from './errors';
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface UpstreamOperation {
  id: string; machineId: string; type: string; state: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string; error?: { code?: string } | null; machine?: unknown;
}
function malformed(): never { throw new PanelError(502, 'invalid_upstream_response', 'InstaBox 返回的数据不完整，请稍后刷新。'); }
export function machineView(raw: unknown): Machine {
  const m = raw as Record<string, any>;
  if (!m || typeof m.id !== 'string' || typeof m.name !== 'string' || !machineStates.includes(m.state)) malformed();
  return {
    id: m.id, name: m.name, orgId: typeof m.orgId === 'string' ? m.orgId : '',
    state: m.state as MachineState, operationId: typeof m.operationId === 'string' ? m.operationId : null,
    revision: Number(m.revision) || 0, autoSuspendAfterSeconds: typeof m.autoSuspendAfterSeconds === 'number' ? m.autoSuspendAfterSeconds : null,
    autoSuspendedAt: typeof m.autoSuspendedAt === 'string' ? m.autoSuspendedAt : undefined,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '', updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : '',
    spec: { vcpus: Number(m.spec?.vcpus) || 0, memMiB: Number(m.spec?.memMiB) || 0 },
    runtime: { ready: m.runtime?.ready === true,
      ...(typeof m.runtime?.processesPreserved === 'boolean' ? { processesPreserved: m.runtime.processesPreserved } : {}) },
  };
}
export class Instabox {
  constructor(private apiKey: string, private fetcher: Fetcher = (input, init) => fetch(input, init)) {}
  async request(path: string, init: RequestInit = {}, timeout = 15000): Promise<any> {
    const response = await this.response(path, init, timeout);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { malformed(); }
  }
  async response(path: string, init: RequestInit = {}, timeout = 15000): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.instabox.sh' + path, {
        ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        headers: { 'Accept': 'application/json', 'X-API-Key': this.apiKey, ...init.headers },
      });
    } catch (error) {
      if (error instanceof PanelError && error.code === 'automation_budget') throw error;
      throw new PanelError(502, 'upstream_unreachable', '暂时无法连接 InstaBox，操作结果可能尚未确认。', true);
    }
    if (response.status >= 300 && response.status < 400)
      throw new PanelError(502, 'upstream_redirect', 'InstaBox 返回了非预期跳转，已停止请求。');
    if (response.ok) return response;
    let data: any;
    try { data = await response.json(); } catch { malformed(); }
    if (!response.ok) {
      const rawCode = data?.error?.code;
      const code = typeof rawCode === 'string' && /^[a-z0-9_]{1,80}$/.test(rawCode) ? rawCode :
        response.status === 401 ? 'invalid_api_key' : response.status === 429 ? 'rate_limited' : 'upstream_error';
      const retryable = response.status >= 500 || response.status === 429;
      // Do not expose untrusted upstream messages, headers, or credentials.
      throw new PanelError(response.status === 401 || response.status === 403 ? 422 : response.status, code, safeUpstreamMessage(code), retryable);
    }
    return response;
  }
  async me() {
    const raw = await this.request('/v1/me');
    if (!raw || !(typeof raw.userId === 'string' || Number.isSafeInteger(raw.userId))) malformed();
    return { userId: String(raw.userId), login: String(raw.login || ''), email: String(raw.email || '') };
  }
  async list(): Promise<Machine[]> {
    const machines = new Map<string, Machine>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 30; page++) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const data = await this.request('/v1/machines?' + query);
      if (!data || !Array.isArray(data.machines) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) malformed();
      for (const raw of data.machines) { const m = machineView(raw); machines.set(m.id, m); }
      if (data.nextCursor === null) return [...machines.values()];
      if (!data.nextCursor || cursors.has(data.nextCursor)) malformed();
      cursors.add(data.nextCursor);
      cursor = data.nextCursor;
    }
    throw new PanelError(502, 'pagination_limit', '机器列表超过单次分页上限，未返回不完整列表。');
  }
  async machine(id: string): Promise<Machine> {
    return machineView(await this.request('/v1/machines/' + encodeURIComponent(id)));
  }
  async change(id: string, type: string, idempotencyKey: string): Promise<UpstreamOperation> {
    return this.operationView(await this.request('/v1/machines/' + encodeURIComponent(id) + '/' + type, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
    }));
  }
  async operation(id: string, wait: number): Promise<UpstreamOperation> {
    return this.operationView(await this.request('/v1/operations/' + encodeURIComponent(id) + '?wait=' + wait + 's', {}, (wait + 8) * 1000));
  }
  private operationView(raw: any): UpstreamOperation {
    if (!raw || typeof raw.id !== 'string' || typeof raw.machineId !== 'string' ||
        !['queued', 'running', 'succeeded', 'failed'].includes(raw.state)) malformed();
    return raw;
  }
}
