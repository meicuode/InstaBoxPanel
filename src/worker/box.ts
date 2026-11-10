import type { SimularBox } from '../shared/box';
import { PanelError } from './errors';
import type { Fetcher } from './instabox';

const endpoint = 'https://mcp.box.simular.ai/mcp';
interface ToolContent { type?: string; text?: string }
interface RpcResult { structuredContent?: unknown; content?: ToolContent[]; isError?: boolean }
interface ToolValue { boxes?: unknown[]; box_id?: string; state?: string; [key: string]: unknown }

function parsePayload(text: string): { result?: RpcResult; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split('\n').map(line => line.trim()).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim()).filter(Boolean);
  if (!data.length) throw new Error('empty response');
  return JSON.parse(data[data.length - 1]);
}
function parseContent(content: ToolContent[] | undefined): unknown {
  const text = content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
}
async function callTool(apiKey: string, name: string, args: Record<string, unknown>, fetcher: Fetcher, timeoutMs: number): Promise<ToolValue> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    throw new PanelError(502, 'box_unreachable', '暂时无法连接 box 服务，请稍后重试。', true);
  }
  if (response.status === 401 || response.status === 403)
    throw new PanelError(422, 'box_key_invalid', 'box 密钥无效或已被撤销，请重新填写。');
  if (!response.ok) throw new PanelError(502, 'box_unreachable', 'box 服务暂时不可用，请稍后重试。', true);
  let payload: { result?: RpcResult; error?: unknown };
  try { payload = parsePayload(await response.text()); }
  catch { throw new PanelError(502, 'box_invalid_response', 'box 服务返回了无法识别的内容，请稍后重试。', true); }
  if (payload.error || !payload.result) throw new PanelError(502, 'box_unavailable', 'box 服务拒绝了请求，请稍后重试。', true);
  if (payload.result.isError) throw new PanelError(502, 'box_tool_failed', 'box 操作未完成，请稍后重试。', true);
  let value: unknown;
  try { value = payload.result.structuredContent ?? parseContent(payload.result.content); }
  catch { value = undefined; }
  if (!value || typeof value !== 'object') throw new PanelError(502, 'box_invalid_response', 'box 服务返回了无法识别的内容，请稍后重试。', true);
  return value as ToolValue;
}

export async function listBoxes(apiKey: string, fetcher: Fetcher): Promise<SimularBox[]> {
  const value = await callTool(apiKey, 'box_list', {}, fetcher, 20000);
  if (!Array.isArray(value.boxes)) return [];
  return value.boxes.map((entry: unknown) => {
    const box = entry as Record<string, unknown>;
    return {
      boxId: typeof box.box_id === 'string' ? box.box_id : '',
      name: typeof box.name === 'string' ? box.name : '',
      state: typeof box.state === 'string' ? box.state : '',
      image: typeof box.image === 'string' ? box.image : '',
      viewUrl: typeof box.view_url === 'string' ? box.view_url : '',
    };
  }).filter(box => /^[a-zA-Z0-9_-]{1,128}$/.test(box.boxId));
}

export async function ensureBox(apiKey: string, boxId: string, fetcher: Fetcher): Promise<{ boxId: string; state: string }> {
  const value = await callTool(apiKey, 'box_ensure', { box: boxId, wait: false }, fetcher, 45000);
  return { boxId: typeof value.box_id === 'string' ? value.box_id : boxId, state: typeof value.state === 'string' ? value.state : '' };
}
