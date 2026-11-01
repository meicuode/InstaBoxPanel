import { baseName, filePath, parentPath, uploadChunkBytes, maxMultipartBytes, type UploadState } from '../shared/files';
import { decryptKey, encryptKey } from './crypto';
import { PanelError } from './errors';
import { resourceBody, resourceId, type ResourceAccess, type ResourceApp, type ResourceContext } from './resource-context';
import { uploadScript } from './upload-script';
import { streamUpload } from './upload-stream';
import type { Instabox } from './instabox';

interface Ticket { version: 1; id: string; path: string; guard: string; size: number; chunkSize: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages: Record<string, string> = {
  multipart_tools_missing: '机器缺少 bash、GNU coreutils 或 flock，无法分片合并；无需安装 Python。',
  upload_permission: '没有写入目标目录或文件的权限。', missing_parent: '目标目录不存在，请勾选自动创建目录。',
  invalid_upload: '上传任务或临时目录无效，请清理后重新上传。', upload_missing: '临时分片已不存在，请清理此任务后重新上传。',
  upload_directory_changed: '目标目录已改变，已停止上传；请核对路径后重新创建任务。',
  not_a_file: '目标是目录、符号链接或特殊文件，请选择普通文件路径。',
  file_exists: '目标已存在，请确认覆盖这个文件。', upload_busy: '上传任务正在处理，请稍后重试。',
  upload_part_conflict: '已上传分片与所选文件不一致，请选择原文件，或清理此任务后重新上传。',
  upload_part_invalid: '分片长度或校验值不匹配，请重新上传该分片。', upload_closed: '此任务正在合并或已完成，请查询上传结果。',
  upload_incomplete: '分片尚未全部上传，请继续上传后再合并。', assembly_failed: '文件合并失败，请检查磁盘剩余空间及目录权限后继续上传。',
  assembly_interrupted: '上次合并被中断，可以利用已有分片重新合并。',
  upload_cleanup_refused: '临时目录中有不属于上传任务的内容，未清理；请通过文件管理核对。',
};
function uploadError(code: string): never {
  if (!Object.hasOwn(messages, code)) code = 'invalid_upload';
  throw new PanelError(code === 'upload_busy' ? 409 : ['invalid_upload', 'upload_part_invalid'].includes(code) ? 400 : 409,
    code, messages[code] || '上传任务未完成，请核对机器状态后重试。');
}
function pathInput(value: unknown) {
  try { const path = filePath(value); if (path === '/') throw new Error(); return path; }
  catch { throw new PanelError(400, 'invalid_file_path', '请指定文件的完整绝对路径，不能使用根目录、. 或 ..。'); }
}
function malformed(): never { throw new PanelError(502, 'invalid_upload_response', '未能确认分片任务状态，请稍后继续上传以核对结果。'); }
function parseOutput(stdout: string, data: Ticket): UploadState {
  const marker = 'PANEL_UPLOAD_V1 ' + data.guard + '\n', offset = stdout.lastIndexOf(marker);
  if (offset < 0) malformed();
  const lines = stdout.slice(offset + marker.length).split('\n'), end = lines.indexOf('END');
  if (end < 0) malformed();
  const value = (key: string) => lines.slice(0, end).find(line => line.startsWith(key + ' '))?.slice(key.length + 1);
  const rawPath = value('PATH'), state = value('STATE'), rawError = value('ERROR');
  const errorCode = rawError ? Object.hasOwn(messages, rawError) ? rawError : 'invalid_upload' : undefined;
  if (!state) uploadError(errorCode || 'invalid_upload');
  if (!['uploading', 'merging', 'failed', 'complete'].includes(state)) malformed();
  let path: string;
  try { path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(rawPath || ''), c => c.charCodeAt(0))); if (filePath(path) !== path || baseName(path) !== baseName(data.path)) malformed(); }
  catch { malformed(); }
  const parts = lines.slice(0, end).filter(line => line.startsWith('PART ')).map(line => {
    const match = line.match(/^PART (0|[1-9][0-9]*) ([0-9a-f]{64})$/);
    if (!match || Number(match[1]) >= Math.ceil(data.size / data.chunkSize)) malformed();
    return { index: Number(match[1]), sha256: match[2] };
  });
  if (new Set(parts.map(p => p.index)).size !== parts.length) malformed();
  const result = value('RESULT')?.match(/^(\d+) ([0-9a-f]{64}) ([0-7]{3,4}) (true|false)$/);
  if (state === 'complete' && (!result || Number(result[1]) !== data.size)) malformed();
  return { path, state: state as UploadState['state'], parts, ...(errorCode ? { errorCode, error: messages[errorCode] || '合并未完成，请重试。' } : {}),
    ...(result ? { result: { path, size: Number(result[1]), sha256: result[2], mode: result[3], created: result[4] === 'true' } } : {}) };
}
async function job(remote: Instabox, base: string, data: Ticket, action: string, options: { index?: number; nonce?: string; hash?: string; overwrite?: boolean; parents?: boolean } = {}) {
  const result = await remote.request(base + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    argv: ['bash', '-c', uploadScript, 'panel-upload-v1', action, data.path, data.id, data.guard, String(data.size), String(data.chunkSize),
      String(options.index || 0), options.nonce || '', options.hash || '', String(options.overwrite === true), String(options.parents === true)],
    cwd: '/', timeoutSeconds: 25, noHistory: true,
  }) }, 35000);
  if (!result || typeof result.stdout !== 'string' || !Number.isInteger(result.exitCode) || result.timedOut || result.truncated) malformed();
  if (action === 'cleanup' && result.exitCode === 0) return { path: data.path, state: 'uploading', parts: [] } as UploadState;
  if (result.exitCode === 127) uploadError('multipart_tools_missing');
  const state = parseOutput(result.stdout, data);
  if (result.exitCode !== 0) uploadError(state.errorCode || 'invalid_upload');
  return state;
}
export function registerMultipartRoutes(app: ResourceApp, access: ResourceAccess) {
  const route = '/api/accounts/:id/machines/:machineId/files/uploads';
  async function context(c: ResourceContext) {
    const accountId = resourceId(c.req.param('id')), machineId = resourceId(c.req.param('machineId'));
    const account = await access.account(c.env.DB, accountId), identity = c.get('identity');
    return { remote: await access.remote(identity, account), base: '/v1/machines/' + machineId, identity, binding: 'file-upload:' + accountId + ':' + machineId };
  }
  async function opened(c: ResourceContext, raw: unknown) {
    const ctx = await context(c), id = c.req.param('uploadId'); let data: Ticket;
    try {
      if (typeof raw !== 'string' || raw.length > 8000 || !id || !uuid.test(id)) throw new Error();
      const [iv, ciphertext, rest] = raw.split('.'); if (rest !== undefined) throw new Error();
      data = JSON.parse(await decryptKey(ciphertext, iv, ctx.identity.key, ctx.binding));
      if (data.version !== 1 || data.id !== id || !uuid.test(data.id) || pathInput(data.path) !== data.path || !/^[0-9a-f]{64}$/.test(data.guard) ||
          !Number.isSafeInteger(data.size) || data.size <= 0 || data.size > maxMultipartBytes || data.chunkSize !== uploadChunkBytes) throw new Error();
    } catch { throw new PanelError(400, 'invalid_upload_ticket', '上传任务与账号或机器不匹配，请重新选择正确的上传任务。'); }
    return { ...ctx, data };
  }
  app.post(route, async c => {
    const body = await resourceBody(c), path = pathInput(body.path);
    if (typeof body.uploadId !== 'string' || !uuid.test(body.uploadId) || !Number.isSafeInteger(body.size) || Number(body.size) <= 0 || Number(body.size) > maxMultipartBytes ||
        typeof body.parents !== 'boolean' || typeof body.overwrite !== 'boolean') throw new PanelError(400, 'invalid_upload', '分片上传参数无效，单文件最多 20 GiB。');
    const ctx = await context(c);
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(ctx.identity.key), v => v.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([ctx.binding, body.uploadId, path, body.size])));
    const guard = Array.from(new Uint8Array(signature), v => v.toString(16).padStart(2, '0')).join('');
    const data: Ticket = { version: 1, id: body.uploadId, path, size: Number(body.size), chunkSize: uploadChunkBytes, guard };
    const state = await job(ctx.remote, ctx.base, data, 'init', { parents: body.parents, overwrite: body.overwrite });
    data.path = state.path;
    const sealed = await encryptKey(JSON.stringify(data), ctx.identity.key, ctx.binding);
    return c.json({ ...state, uploadId: data.id, chunkSize: data.chunkSize, ticket: sealed.iv + '.' + sealed.ciphertext });
  });
  app.post(route + '/:uploadId/status', async c => {
    const body = await resourceBody(c), { remote, base, data } = await opened(c, body.ticket);
    return c.json(await job(remote, base, data, 'status'));
  });
  app.put(route + '/:uploadId/parts/:index', async c => {
    const { remote, base, data } = await opened(c, c.req.header('X-Upload-Ticket'));
    const rawIndex = c.req.param('index') || '', hash = c.req.header('X-Chunk-SHA256') || '';
    if (!/^(0|[1-9][0-9]{0,4})$/.test(rawIndex) || Number(rawIndex) >= Math.ceil(data.size / data.chunkSize) || !/^[0-9a-f]{64}$/.test(hash)) uploadError('invalid_upload');
    const index = Number(rawIndex), nonce = crypto.randomUUID(), size = Math.min(data.chunkSize, data.size - index * data.chunkSize);
    const length = c.req.header('Content-Length');
    if (length !== undefined && Number(length) !== size) uploadError('upload_part_invalid');
    await job(remote, base, data, 'prepare', { index, nonce, hash });
    const incoming = parentPath(data.path).replace(/\/$/, '') + '/.instabox-upload-' + data.id + '/incoming-' + nonce;
    await streamUpload(remote, base, incoming, c.req.raw, data.chunkSize, false, size, hash);
    return c.json(await job(remote, base, data, 'accept', { index, nonce, hash }));
  });
  app.post(route + '/:uploadId/finish', async c => {
    const body = await resourceBody(c); if (typeof body.overwrite !== 'boolean') uploadError('invalid_upload');
    const { remote, base, data } = await opened(c, body.ticket);
    return c.json(await job(remote, base, data, 'finish', { overwrite: body.overwrite }));
  });
  app.delete(route + '/:uploadId', async c => {
    const body = await resourceBody(c), { remote, base, data } = await opened(c, body.ticket);
    await job(remote, base, data, 'cleanup'); return c.json({ ok: true });
  });
}
