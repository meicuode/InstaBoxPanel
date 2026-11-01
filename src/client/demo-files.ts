import type { Account, Machine } from '../shared/types';
import { ApiError } from './api';
import { baseName, filePath, joinPath, maxPreviewBytes, maxUploadBytes, parentPath, type FileView, type FileWritten } from '../shared/files';
type DemoNode = { directory: boolean; blob: Blob; time: string };
const libraries = new Map<string, Map<string, DemoNode>>();
const node = (directory: boolean, content = ''): DemoNode => ({ directory, blob: new Blob([content]), time: new Date().toISOString() });
function library(id: string) {
  if (!libraries.has(id)) libraries.set(id, new Map([
    ['/', node(true)], ['/data', node(true)], ['/data/home', node(true)], ['/data/home/workspace', node(true)],
    ['/data/home/README.md', node(false, '# 欢迎使用文件管理\n\n选择目录后上传文件，也可以填写完整的目标目录。\n演示文件只保存在当前页面内存中。\n')],
    ['/data/home/workspace/example.txt', node(false, 'Hello, InstaBox!\n')],
  ]));
  return libraries.get(id)!;
}
export async function demoFiles(url: URL, method: string, rawBody: unknown, accounts: Account[], machines: Record<string, Machine[]>): Promise<unknown> {
  const match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/machines\/([^/]+)\/files(\/content|\/directory)?$/);
  if (!match) return undefined;
  const [, accountId, machineId, operation] = match;
  if (!accounts.some(a => a.id === accountId && a.enabled)) throw new ApiError('account_disabled', '账号不存在或已停用。', 409);
  const machine = machines[accountId]?.find(m => m.id === machineId);
  if (!machine) throw new ApiError('not_found', '机器不存在。', 404);
  if (machine.state !== 'running') throw new ApiError('machine_not_running', '机器尚未运行，请先恢复或启动机器。', 409);
  const body = rawBody as Record<string, any> | undefined;
  const entries = library(machineId), path = filePath(method === 'GET' || method === 'PUT' ? url.searchParams.get('path') || '/data/home' : body?.path);
  const entry = entries.get(path);
  if (method === 'GET') {
    if (!entry) throw new ApiError('not_found', '路径不存在。', 404);
    if (operation === '/content') {
      if (entry.directory) throw new ApiError('not_a_file', '目录不能下载。', 409);
      return entry.blob;
    }
    const bytes = new Uint8Array(await entry.blob.slice(0, maxPreviewBytes).arrayBuffer());
    let content = '', binary = false;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); binary = bytes.includes(0); } catch { binary = true; }
    const view: FileView = { path, type: entry.directory ? 'dir' : 'file', mode: entry.directory ? 'drwxr-xr-x' : '-rw-r--r--', modTime: entry.time,
      size: entry.blob.size, content: binary ? '' : content, binary, truncated: entry.blob.size > maxPreviewBytes,
      entries: [...entries].filter(([p]) => p !== path && parentPath(p) === path).map(([p, n]) => ({ name: baseName(p), type: n.directory ? 'dir' as const : 'file' as const, size: n.blob.size, mode: n.directory ? 'drwxr-xr-x' : '-rw-r--r--', modTime: n.time })) };
    view.entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    return view;
  }
  if (path === '/') throw new ApiError('root_protected', '不能修改根目录。', 400);
  if (method === 'PUT' && operation === '/content') {
    if (!(rawBody instanceof Blob) || rawBody.size > maxUploadBytes) throw new ApiError('file_too_large', '单个文件最多 95 MiB。', 413);
    if (entry && url.searchParams.get('overwrite') !== 'true') throw new ApiError('file_exists', '目标已存在，请确认覆盖这个文件。', 409);
    if (entry?.directory) throw new ApiError('not_a_file', '目标是目录。', 409);
    function ensureParent(p: string) {
      if (entries.has(p)) { if (!entries.get(p)!.directory) throw new ApiError('not_a_file', '目标路径不是目录。', 409); return; }
      if (url.searchParams.get('parents') !== 'true') throw new ApiError('missing_parent', '目标目录不存在，请先创建目录或勾选自动创建目录。', 404);
      ensureParent(parentPath(p)); entries.set(p, node(true));
    }
    ensureParent(parentPath(path));
    const hash = await crypto.subtle.digest('SHA-256', await rawBody.arrayBuffer());
    entries.set(path, { directory: false, blob: rawBody, time: new Date().toISOString() });
    const result: FileWritten = { path, size: rawBody.size, mode: '0644', created: !entry, sha256: [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('') };
    return result;
  }
  if (method === 'POST' && operation === '/directory') {
    if (entry) throw new ApiError('file_exists', '目录名称已存在。', 409);
    if (!entries.get(parentPath(path))?.directory) throw new ApiError('missing_parent', '上级目录不存在。', 404);
    entries.set(path, node(true)); return { ok: true, path };
  }
  if (!entry) throw new ApiError('not_found', '路径不存在。', 404);
  if (method === 'PATCH') {
    const target = joinPath(parentPath(path), body?.name);
    if (entries.has(target)) throw new ApiError('file_exists', '新名称已存在。', 409);
    for (const [p, n] of [...entries]) if (p === path || p.startsWith(path + '/')) { entries.delete(p); entries.set(target + p.slice(path.length), n); }
    return { ok: true, path: target };
  }
  if (method === 'DELETE') {
    if (body?.confirmPath !== path || (entry.directory && body?.recursive !== true)) throw new ApiError('file_confirmation_required', '请填写完整路径确认删除。', 400);
    for (const p of entries.keys()) if (p === path || p.startsWith(path + '/')) entries.delete(p);
    return { ok: true };
  }
  throw new ApiError('not_found', '接口不存在。', 404);
}
