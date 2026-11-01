import { ApiError, isDemo } from './api';
import { baseName, maxUploadBytes, type FileWritten } from '../shared/files';

export async function uploadFile(base: string, file: File, path: string, parents: boolean, overwrite: boolean, signal: AbortSignal, progress: (percent: number) => void): Promise<FileWritten> {
  if (file.size > maxUploadBytes) throw new ApiError('file_too_large', '单个文件最多 95 MiB。', 413);
  const url = base + '/content?' + new URLSearchParams({ path, parents: String(parents), overwrite: String(overwrite) });
  if (isDemo) {
    const { demoRequest } = await import('./demo');
    const result = await demoRequest(url, { method: 'PUT', body: file, signal }) as FileWritten;
    progress(100); return result;
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: ApiError, value?: FileWritten) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    xhr.open('PUT', url); xhr.timeout = 15 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Panel-Request', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onerror = () => finish(new ApiError('network_error', '连接中断，上传结果尚未确认。'));
    xhr.ontimeout = () => finish(new ApiError('upload_timeout', '上传超时，结果尚未确认。'));
    xhr.onabort = () => finish(new ApiError('upload_cancelled', '上传已取消，请刷新目录核对文件是否已保存。'));
    xhr.onload = () => {
      if (!xhr.getResponseHeader('Content-Type')?.includes('application/json')) {
        finish(new ApiError('upload_response_invalid', '未收到有效的上传结果，请刷新目录核对。', xhr.status >= 400 ? xhr.status : 502)); return;
      }
      let value: any;
      try { value = JSON.parse(xhr.responseText); }
      catch { finish(new ApiError('upload_response_invalid', '上传结果尚未确认，请刷新目录核对。', 502)); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new ApiError(value.error?.code || 'upload_failed', value.error?.message || '上传失败，请稍后重试。', xhr.status)); return;
      }
      if (value.size !== file.size || typeof value.path !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) {
        finish(new ApiError('upload_response_invalid', '上传结果尚未确认，请刷新目录核对。', 502)); return;
      }
      finish(undefined, value);
    };
    if (signal.aborted) { finish(new ApiError('upload_cancelled', '上传已取消。')); return; }
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

export async function downloadFile(base: string, path: string) {
  let href = base + '/content?' + new URLSearchParams({ path });
  if (isDemo) {
    const { demoRequest } = await import('./demo');
    href = URL.createObjectURL(await demoRequest(href, {}) as Blob);
  }
  const anchor = document.createElement('a');
  anchor.href = href; anchor.download = baseName(path); anchor.rel = 'noopener';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  if (isDemo) setTimeout(() => URL.revokeObjectURL(href), 60000);
}
