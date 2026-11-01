import type { Instabox } from './instabox';
import { PanelError } from './errors';
import type { FileWritten } from '../shared/files';

export async function streamUpload(remote: Instabox, base: string, path: string, request: Request, limit: number, parents: boolean, expectedSize?: number, expectedHash?: string): Promise<FileWritten> {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new PanelError(400, 'invalid_content_length', '上传长度无效。');
  if (Number(length) > limit) throw new PanelError(413, 'file_too_large', '本次上传内容超过单次请求上限。');
  let received = 0, tooLarge = false, complete = false;
  const input = request.body || new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const body = input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) { tooLarge = true; throw new Error('upload limit'); }
      controller.enqueue(chunk);
    },
    flush() {
      if ((length !== null && received !== Number(length)) || (expectedSize !== undefined && received !== expectedSize)) throw new Error('incomplete upload');
      complete = true;
    },
  }));
  let result: any;
  try {
    result = await remote.request(base + '/files?' + new URLSearchParams({ path, parents: String(parents) }), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body, signal: request.signal,
    }, 15 * 60 * 1000);
  } catch (e) {
    if (tooLarge) throw new PanelError(413, 'file_too_large', '本次上传内容过大，已中断。');
    throw e;
  } finally { if (!body.locked) await body.cancel().catch(() => {}); }
  if (!complete || !result || result.size !== received || !/^[0-9a-f]{64}$/i.test(result.sha256) ||
      (expectedHash && result.sha256 !== expectedHash) || typeof result.created !== 'boolean' || typeof result.mode !== 'string' || typeof result.path !== 'string')
    throw new PanelError(502, 'invalid_file_response', '上传校验未通过，请重新核对或上传。');
  return { path: result.path, size: result.size, sha256: result.sha256, created: result.created, mode: result.mode };
}
