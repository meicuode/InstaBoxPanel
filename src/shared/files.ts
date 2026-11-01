// Below Cloudflare's 100 MB request limit; file bodies are streamed, never JSON/base64.
export const maxUploadBytes = 95 * 1024 * 1024;
export const uploadChunkBytes = 16 * 1024 * 1024;
export const maxMultipartBytes = 20 * 1024 * 1024 * 1024;
export interface UploadState {
  path: string; state: 'uploading' | 'merging' | 'failed' | 'complete';
  parts: { index: number; sha256: string }[]; result?: FileWritten; error?: string; errorCode?: string;
}
export interface UploadSession extends UploadState { ticket: string; uploadId: string; chunkSize: number }
export const maxPreviewBytes = 256 * 1024;
export interface FileEntry {
  name: string; type: 'dir' | 'file' | 'symlink' | 'other'; size: number; mode: string; modTime: string; target?: string;
}
export interface FileView {
  path: string; type: 'dir' | 'file' | 'other'; size: number; mode: string; modTime: string;
  entries: FileEntry[]; content: string; binary: boolean; truncated: boolean;
}
export interface FileWritten { path: string; size: number; sha256: string; mode: string; created: boolean }
export function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) ||
      new TextEncoder().encode(value).length > 4096 || value.split('/').some(s => s === '.' || s === '..'))
    throw new Error('请输入不含 .、.. 或控制字符的绝对路径，最长 4096 字节。');
  return '/' + value.split('/').filter(Boolean).join('/');
}
export function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('/') || value === '.' || value === '..' ||
      /[\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 255)
    throw new Error('名称需要 1–255 字节，不能包含 /、控制字符或使用 .、..。');
  return value;
}
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (directory: string, name: string) => filePath((filePath(directory) === '/' ? '' : filePath(directory)) + '/' + fileName(name));
export function fileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
}
