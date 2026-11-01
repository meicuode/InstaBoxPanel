import { baseName, fileName, filePath, joinPath, maxPreviewBytes, maxUploadBytes, parentPath, type FileView } from '../shared/files';
import { PanelError } from './errors';
import type { Instabox } from './instabox';
import { resourceBody, resourceId, type ResourceAccess, type ResourceApp, type ResourceContext } from './resource-context';
import { streamUpload } from './upload-stream';
import { registerMultipartRoutes } from './multipart';

export const isFileUpload = (method: string, path: string) => method === 'PUT' && /^\/api\/accounts\/[^/]+\/machines\/[^/]+\/files\/(?:content|uploads\/[0-9a-f-]+\/parts\/\d+)$/.test(path);
function validate<T>(task: () => T): T {
  try { return task(); } catch (e) { throw new PanelError(400, 'invalid_file_path', (e as Error).message); }
}
function writablePath(value: unknown) {
  const path = validate(() => filePath(value));
  if (path === '/') throw new PanelError(400, 'root_protected', '不能覆盖、重命名或删除根目录。');
  return path;
}
function malformed(): never { throw new PanelError(502, 'invalid_file_response', '文件服务返回的数据不完整，请刷新目录后核对结果。'); }
function metadata(raw: any) {
  if (!raw || !Number.isSafeInteger(raw.size) || raw.size < 0 || typeof raw.mode !== 'string' || raw.mode.length > 32 ||
      typeof raw.modTime !== 'string' || !Number.isFinite(Date.parse(raw.modTime))) malformed();
  return { size: raw.size, mode: raw.mode, modTime: raw.modTime };
}
export function fileView(raw: any): FileView {
  const meta = metadata(raw);
  let path: string;
  try { path = filePath(raw.path); } catch { malformed(); }
  if (!['dir', 'file', 'other'].includes(raw.type) || (raw.entries !== undefined && (!Array.isArray(raw.entries) || raw.entries.length > 5000)) ||
      (raw.content !== undefined && (typeof raw.content !== 'string' || new TextEncoder().encode(raw.content).length > maxPreviewBytes + 4)) ||
      (raw.binary !== undefined && typeof raw.binary !== 'boolean') || (raw.truncated !== undefined && typeof raw.truncated !== 'boolean')) malformed();
  const entries = (raw.entries || []).map((entry: any) => {
    const meta = metadata(entry);
    if (typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') ||
        entry.name.includes('\0') || new TextEncoder().encode(entry.name).length > 255 || !['dir', 'file', 'symlink', 'other'].includes(entry.type) ||
        (entry.target !== undefined && typeof entry.target !== 'string')) malformed();
    return { ...meta, name: entry.name, type: entry.type, ...(entry.target ? { target: entry.target.slice(0, 4096) } : {}) };
  });
  if (new Set(entries.map((e: { name: string }) => e.name)).size !== entries.length) malformed();
  return { ...meta, path, type: raw.type, entries, content: raw.binary ? '' : raw.content || '', binary: raw.binary === true, truncated: raw.truncated === true };
}
async function fileCall<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); } catch (e) {
    if (e instanceof PanelError) {
      const messages: Record<string, string> = {
        insufficient_scope: '文件管理需要 machines:write 权限，请在账号设置中替换 API Key。',
        permission_denied: '没有访问这个路径的权限；上传和修改使用机器的登录用户权限。',
        missing_parent: '目标目录不存在，请先新建目录或勾选自动创建目录。',
        not_a_file: '目标是目录或特殊文件，请选择普通文件路径。',
        no_space: '机器磁盘空间不足，请释放空间后重试。',
        machine_not_running: '机器尚未运行，请先恢复或启动机器，再打开文件管理。',
        not_found: '路径不存在，或当前账号无权访问这台机器。',
        quota_exceeded: '同时进行的请求过多，请等待其他任务完成后重试。',
      };
      if (messages[e.code]) throw new PanelError(e.status, e.code, messages[e.code], e.retryable);
    }
    throw e;
  }
}
async function read(remote: Instabox, base: string, path: string) {
  return fileView(await fileCall(() => remote.request(base + '/files?' + new URLSearchParams({ path }), {}, 30000)));
}
async function command(remote: Instabox, base: string, argv: string[]) {
  const result = await fileCall(() => remote.request(base + '/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv, cwd: '/', timeoutSeconds: 20 }),
  }, 30000));
  if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.timedOut !== 'boolean') malformed();
  if (result.timedOut) throw new PanelError(504, 'file_operation_uncertain', '文件操作超时，结果尚未确认，请刷新目录核对。');
  if (result.exitCode !== 0) throw new PanelError(409, 'file_operation_failed', '未能完成文件操作，请检查路径、同名项目和写入权限后刷新目录。');
  return result;
}

export function registerFileRoutes(app: ResourceApp, access: ResourceAccess) {
  const route = '/api/accounts/:id/machines/:machineId/files';
  async function context(c: ResourceContext) {
    const id = resourceId(c.req.param('machineId'));
    const account = await access.account(c.env.DB, resourceId(c.req.param('id')));
    return { remote: await access.remote(c.get('identity'), account), base: '/v1/machines/' + encodeURIComponent(id) };
  }
  app.get(route, async c => {
    const path = validate(() => filePath(c.req.query('path') ?? '/data/home'));
    const { remote, base } = await context(c);
    return c.json(await read(remote, base, path));
  });
  app.get(route + '/content', async c => {
    const path = writablePath(c.req.query('path'));
    const { remote, base } = await context(c);
    const response = await fileCall(() => remote.response(base + '/files/content?' + new URLSearchParams({ path }), {
      signal: c.req.raw.signal,
    }, 2 * 60 * 60 * 1000));
    // Download as an attachment. Never serve remote HTML/SVG on the panel origin.
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': "attachment; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(baseName(path)).replace(/['()*]/g, v => '%' + v.charCodeAt(0).toString(16)) });
    const length = response.headers.get('Content-Length');
    if (length && /^\d+$/.test(length)) headers.set('Content-Length', length);
    return new Response(response.body, { headers });
  });
  app.put(route + '/content', async c => {
    const path = writablePath(c.req.query('path'));
    for (const name of ['parents', 'overwrite']) if (c.req.query(name) !== undefined && !['true', 'false'].includes(c.req.query(name)!))
      throw new PanelError(400, 'invalid_upload_option', '上传选项无效。');
    const length = c.req.header('Content-Length');
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
      throw new PanelError(400, 'invalid_content_length', '上传长度无效。');
    if (Number(length) > maxUploadBytes) throw new PanelError(413, 'file_too_large', '单个文件最多 95 MiB。');
    const { remote, base } = await context(c);
    if (c.req.query('overwrite') !== 'true') {
      let exists = false;
      try { await read(remote, base, path); exists = true; }
      catch (e) { if (!(e instanceof PanelError && e.status === 404 && e.code === 'not_found')) throw e; }
      if (exists) throw new PanelError(409, 'file_exists', '目标已存在，请确认覆盖这个文件。');
    }
    const written = await fileCall(() => streamUpload(remote, base, path, c.req.raw, maxUploadBytes, c.req.query('parents') === 'true'));
    return c.json(written, written.created ? 201 : 200);
  });
  app.post(route + '/directory', async c => {
    const body = await resourceBody(c), path = writablePath(body.path);
    const { remote, base } = await context(c);
    await command(remote, base, ['mkdir', '--', path]);
    return c.json({ ok: true, path }, 201);
  });
  app.patch(route, async c => {
    const body = await resourceBody(c), path = writablePath(body.path);
    const name = validate(() => fileName(body.name)), target = validate(() => joinPath(parentPath(path), name));
    if (path === target) throw new PanelError(400, 'unchanged_name', '请输入不同的新名称。');
    const { remote, base } = await context(c);
    // GNU mv -n never overwrites; -T prevents moving into a same-named directory.
    // -v distinguishes a successful move from the silent no-clobber skip (exit 0).
    const result = await command(remote, base, ['mv', '--no-clobber', '--no-target-directory', '--verbose', '--', path, target]);
    if (!result.stdout.trim()) throw new PanelError(409, 'file_exists', '新名称已存在，未执行重命名。');
    return c.json({ ok: true, path: target });
  });
  app.delete(route, async c => {
    const body = await resourceBody(c), path = writablePath(body.path);
    if (body.confirmPath !== path || typeof body.recursive !== 'boolean')
      throw new PanelError(400, 'file_confirmation_required', '请填写完整路径确认删除。');
    const { remote, base } = await context(c);
    await command(remote, base, ['rm', ...(body.recursive ? ['--recursive', '--one-file-system', '--preserve-root=all'] : []), '--', path]);
    return c.json({ ok: true });
  });
  registerMultipartRoutes(app, access);
}
