import { api, ApiError } from './api';
import { sendBlob } from './file-api';
import { uploadChunkBytes, type FileWritten, type UploadSession, type UploadState } from '../shared/files';

export interface PendingUpload { id: string; base: string; path: string; name: string; size: number; lastModified: number; parents: boolean; ticket?: string; createdAt: number }
const storageKey = 'instabox-panel:multipart:v1';
let fallback: PendingUpload[] = [];
let persistent = true;
function records(): PendingUpload[] {
  if (!persistent) return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(value)) return value.filter(r => r && typeof r.id === 'string' && typeof r.base === 'string' && typeof r.path === 'string' && typeof r.name === 'string' && Number.isSafeInteger(r.size)).slice(0, 100);
  } catch { persistent = false; /* In private browsing, continuation is available in this page's memory. */ }
  return fallback;
}
function save(record: PendingUpload, remove = false) {
  fallback = records().filter(r => r.id !== record.id);
  if (!remove && fallback.length >= 100) throw new ApiError('too_many_uploads', '保留的上传任务过多，请先清理不需要的任务。', 409);
  if (!remove) fallback.push(record);
  try { localStorage.setItem(storageKey, JSON.stringify(fallback)); } catch { persistent = false; }
  window.dispatchEvent(new Event('panel-upload-change'));
}
export const pendingUploads = (base: string) => records().filter(r => r.base === base);
function request<T>(url: string, body: unknown, signal?: AbortSignal, method = 'POST') {
  return api<T>(url, { method, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
}
async function initialize(record: PendingUpload, overwrite: boolean, signal?: AbortSignal) {
  const state = await request<UploadSession>(record.base + '/uploads', { uploadId: record.id, path: record.path, size: record.size, parents: record.parents, overwrite }, signal);
  if (state.uploadId !== record.id || state.chunkSize !== uploadChunkBytes || typeof state.ticket !== 'string') throw new ApiError('invalid_upload_response', '上传任务信息无效。', 502);
  record.ticket = state.ticket; save(record); return state;
}
export async function cleanupUpload(record: PendingUpload) {
  if (!record.ticket) {
    try { await initialize(record, false); }
    catch (e) { if (e instanceof ApiError && e.code === 'file_exists') { save(record, true); return; } throw e; }
  }
  await request(record.base + '/uploads/' + record.id, { ticket: record.ticket }, undefined, 'DELETE'); save(record, true);
}
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1200);
    signal.addEventListener('abort', stop, { once: true });
  });
}
export async function multipartUpload(base: string, file: File, path: string, parents: boolean, overwrite: boolean, signal: AbortSignal, progress: (percent: number, detail?: string) => void): Promise<FileWritten> {
  let record = records().find(r => r.base === base && r.path === path && r.name === file.name && r.size === file.size && r.lastModified === file.lastModified);
  if (!record) { record = { id: crypto.randomUUID(), base, path, name: file.name, size: file.size, lastModified: file.lastModified, parents, createdAt: Date.now() }; save(record); }
  const url = base + '/uploads/' + record.id;
  try {
    signal.throwIfAborted(); progress(0, '正在准备大文件上传…');
    let state = record.ticket ? await request<UploadState>(url + '/status', { ticket: record.ticket }, signal) : await initialize(record, overwrite, signal);
    if (state.state !== 'complete' && state.state !== 'merging') {
      const received = new Map(state.parts.map(part => [part.index, part.sha256]));
      const count = Math.ceil(file.size / uploadChunkBytes);
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const begin = index * uploadChunkBytes, blob = file.slice(begin, Math.min(file.size, begin + uploadChunkBytes));
        progress(Math.round(begin / file.size * 100), '正在校验第 ' + (index + 1) + ' / ' + count + ' 片…');
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()); signal.throwIfAborted();
        const hash = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
        const oldHash = received.get(index);
        if (oldHash && oldHash !== hash) throw new ApiError('upload_part_conflict', '所选文件与已保存的分片不同，请选择原文件，或先清理旧任务。', 409);
        if (!oldHash) {
          const next = await sendBlob<UploadState>(url + '/parts/' + index, blob, signal,
            percent => progress(Math.round((begin + blob.size * percent / 100) / file.size * 100), '正在上传第 ' + (index + 1) + ' / ' + count + ' 片…'),
            { 'X-Upload-Ticket': record.ticket!, 'X-Chunk-SHA256': hash });
          if (!next.parts?.some(p => p.index === index && p.sha256 === hash)) throw new ApiError('invalid_upload_response', '未能确认分片已保存，继续上传时会重新核对。', 502);
        }
        progress(Math.round((begin + blob.size) / file.size * 100), '已保存 ' + (index + 1) + ' / ' + count + ' 片');
      }
      state = await request<UploadState>(url + '/finish', { ticket: record.ticket, overwrite }, signal);
    }
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (state.state === 'merging') {
      progress(100, '正在服务器合并并校验，请稍候…');
      if (Date.now() > deadline) throw new ApiError('upload_timeout', '合并结果尚未确认，稍后点击继续上传可查询结果。');
      await wait(signal); state = await request<UploadState>(url + '/status', { ticket: record.ticket }, signal);
    }
    if (state.state !== 'complete' || !state.result) throw new ApiError(state.errorCode || 'assembly_failed', state.error || '合并未完成，请继续上传以重试。', 409);
    if (state.result.size !== file.size || !/^[0-9a-f]{64}$/.test(state.result.sha256)) throw new ApiError('invalid_upload_response', '完整文件校验结果无效。', 502);
    // Keep the receipt until the client has observed success. Failed cleanup stays visible.
    try { await cleanupUpload(record); } catch { /* User can retry cleanup from the pending list. */ }
    return state.result;
  } catch (e) {
    if (signal.aborted) throw new ApiError('upload_cancelled', '已暂停等待，已保存的分片会保留；已开始的服务器合并可能继续完成。');
    throw e;
  }
}
