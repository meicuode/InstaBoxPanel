import type { KeepaliveMode, TimeWindow } from './keepalive';

export interface SimularBox {
  boxId: string; name: string; state: string; image: string; viewUrl: string;
}
export interface BoxKeepalivePolicy {
  boxId: string; boxName: string; mode: KeepaliveMode; timezone: string; windows: TimeWindow[];
  lastCheckedAt: number | null; lastState: string; lastResult: string; lastError: string;
}
export interface BoxOverview {
  configured: boolean; label: string; keySuffix: string; enabled: boolean;
  intervalMinutes: number; maxBoxes: number;
  boxes: SimularBox[]; policies: BoxKeepalivePolicy[];
  lastRunAt: number | null; error: string;
}
export const BOX_KEEPALIVE_INTERVAL_MINUTES = 1;
export const BOX_KEEPALIVE_MAX_BOXES = 3;

export function validateBoxKey(value: unknown): string {
  if (typeof value !== 'string' || !/^cb_[A-Za-z0-9_-]{32,200}$/.test(value.trim()))
    throw new Error('请输入以 cb_ 开头的 box 个人密钥。');
  return value.trim();
}
export function validateBoxId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('box 标识格式无效。');
  return value;
}
