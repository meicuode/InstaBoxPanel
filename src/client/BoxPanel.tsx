import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, ExternalLink, HeartPulse, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Modal } from './App';
import { api, isDemo } from './api';
import { validateSchedule, type KeepaliveMode, type TimeWindow } from '../shared/keepalive';
import { BOX_KEEPALIVE_MAX_BOXES, type BoxKeepalivePolicy, type BoxOverview, type SimularBox } from '../shared/box';

const message = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请重试。';
const modeLabel = (policy?: BoxKeepalivePolicy) => {
  if (!policy || policy.mode === 'off') return '未开启保活';
  if (policy.mode === 'always') return '全天保活';
  return '时间窗口 · ' + policy.windows.map(window => window.start + '–' + window.end).join('、');
};
function ago(value: number | null) {
  if (!value) return '尚未检查';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return seconds < 5 ? '刚刚' : seconds < 60 ? seconds + ' 秒前' : Math.floor(seconds / 60) + ' 分钟前';
}

function KeyForm({ overview, close, saved }: { overview: BoxOverview; close: () => void; saved: (value: BoxOverview) => void }) {
  const [label, setLabel] = useState(overview.label || 'Simular box');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { saved(await api<BoxOverview>('/api/box', { method: 'PUT', body: { label, apiKey: key } })); close(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={overview.configured ? '更换 box 密钥' : '连接 box'} onClose={() => { if (!busy) close(); }}>
    <p className="dialog-description">在 box.simular.ai/keys 创建个人密钥（以 cb_ 开头）。密钥会用登录主密钥加密后保存在 D1，只用于读取状态和唤醒 box。</p>
    {isDemo && <div className="notice"><ShieldCheck size={17}/><span>演示模式请使用示例密钥 <code>cb_demo_example</code>。</span></div>}
    <form className="account-form" onSubmit={save}>
      <label>显示名称<input autoFocus value={label} maxLength={60} required disabled={busy} onChange={event => setLabel(event.target.value)}/></label>
      <label>个人密钥<input type="password" autoComplete="new-password" spellCheck={false} required disabled={busy} value={key} placeholder="cb_…" onChange={event => setKey(event.target.value)}/></label>
      <p className="field-help">保存前会向 box 校验一次密钥；校验失败不会覆盖现有配置。保存后不再展示完整密钥。</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} {busy ? '正在验证…' : '保存密钥'}</button>
    </form>
  </Modal>;
}

function PolicyForm({ box, policy, close, saved }: {
  box: SimularBox; policy?: BoxKeepalivePolicy; close: () => void; saved: (value: BoxOverview) => void;
}) {
  const [mode, setMode] = useState<KeepaliveMode>(policy?.mode || 'off');
  const [timezone, setTimezone] = useState(policy?.timezone || 'Asia/Shanghai');
  const [windows, setWindows] = useState<TimeWindow[]>(policy?.windows.length ? policy.windows : [{ start: '09:00', end: '18:00' }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const schedule = validateSchedule({ mode, timezone, windows });
      saved(await api<BoxOverview>('/api/box/keepalive/' + encodeURIComponent(box.boxId), {
        method: 'PUT', body: { name: box.name, ...schedule },
      }));
      close();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={'保活 · ' + (box.name || box.boxId)} onClose={() => { if (!busy) close(); }}>
    <p className="dialog-description">每分钟检查一次：运行中保持原样，休眠时发送唤醒，让里面的服务不中断。关闭网页后仍然生效。</p>
    <form className="account-form keepalive-form" onSubmit={save}>
      <fieldset disabled={busy}><legend className="sr-only">保活模式</legend>
        {([['off', '不保活', '默认，让 box 按空闲策略休眠'], ['always', '全天保活', '全天定时唤醒，保持运行'], ['windows', '指定时间范围', '每天仅在指定时间窗口内唤醒']] as const).map(([value, label, description]) =>
          <label className={'keepalive-option' + (mode === value ? ' selected' : '')} key={value}><input type="radio" name="box-keepalive-mode" value={value} checked={mode === value} onChange={() => setMode(value)}/><span><strong>{label}</strong><small>{description}</small></span></label>)}
      </fieldset>
      {mode === 'windows' && <>
        <label>时间范围时区<input value={timezone} onChange={event => setTimezone(event.target.value)} required placeholder="Asia/Shanghai" list="box-timezones"/></label>
        <datalist id="box-timezones">{['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London'].map(zone => <option key={zone} value={zone}/>)}</datalist>
        <div className="keepalive-windows">{windows.map((window, index) => <div className="keepalive-window" key={index}>
          <label>开始<input aria-label={'时间范围 ' + (index + 1) + ' 开始'} type="time" required value={window.start} onChange={event => setWindows(current => current.map((item, position) => position === index ? { ...item, start: event.target.value } : item))}/></label><span>至</span>
          <label>结束<input aria-label={'时间范围 ' + (index + 1) + ' 结束'} type="time" required value={window.end} onChange={event => setWindows(current => current.map((item, position) => position === index ? { ...item, end: event.target.value } : item))}/></label>
          <button type="button" className="icon-button" aria-label={'删除时间范围 ' + (index + 1)} disabled={windows.length === 1} onClick={() => setWindows(current => current.filter((_, position) => position !== index))}><Trash2 size={16}/></button>
        </div>)}</div>
        <button className="button" type="button" disabled={windows.length >= 5} onClick={() => setWindows(current => [...current, { start: '19:00', end: '22:00' }])}><Plus size={15}/>添加时间范围（{windows.length}/5）</button>
        <p className="field-help">支持跨午夜，例如 22:00–06:00；开始时间包含在内，结束时间不包含。</p>
      </>}
      <div className="notice"><HeartPulse size={17}/><span>保活只发送唤醒请求，不会重启 box，也不会改动里面的文件。最多同时保活 {BOX_KEEPALIVE_MAX_BOXES} 台。</span></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}保存保活设置</button>
    </form>
  </Modal>;
}

export default function BoxPanel({ onAuthError, notify }: { onAuthError: (error: unknown) => void; notify: (text: string, error?: boolean) => void }) {
  const [data, setData] = useState<BoxOverview | null>(null);
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(''), [keyOpen, setKeyOpen] = useState(false), [policyBox, setPolicyBox] = useState<SimularBox | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false), [removing, setRemoving] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<BoxOverview>('/api/box')); setError(''); }
    catch (failure) { onAuthError(failure); setError(message(failure)); }
    finally { setLoading(false); setRefreshing(false); }
  }, [onAuthError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);
  async function remove() {
    setRemoving(true); setError('');
    try { await api('/api/box', { method: 'DELETE', body: {} }); setConfirmRemove(false); setData(await api<BoxOverview>('/api/box')); notify('已移除 box 连接。'); }
    catch (failure) { onAuthError(failure); setError(message(failure)); }
    finally { setRemoving(false); }
  }
  if (loading) return <div className="empty"><LoaderCircle size={27} className="spin"/><h3>正在连接 box</h3></div>;
  return <>
    <div className="page-heading box-heading">
      <div><div className="eyebrow">BOX BY SIMULAR</div><h1>box panel</h1><p>给 AI 用的云电脑，状态、画面和保活都在这里。</p></div>
      <button className="button" disabled={refreshing} onClick={() => { setRefreshing(true); void load(); }}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/>刷新状态</button>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!data?.configured ? <section className="box-setup">
      <span className="empty-icon"><HeartPulse size={26}/></span>
      <h2>连接 Simular box</h2>
      <p>粘贴个人密钥后，这里会列出账号下的 box，并可以像 InstaBox 机器一样设置保活。</p>
      <button className="button primary" onClick={() => setKeyOpen(true)}><Plus size={16}/>连接 box</button>
    </section> : <>
      <section className="box-connection">
        <div><ShieldCheck size={18}/><div><strong>{data.label}</strong><small>密钥末尾 {data.keySuffix} · 已加密保存</small></div></div>
        <div className="box-connection-actions">
          <button className="button compact" onClick={() => setKeyOpen(true)}>更换密钥</button>
          <button className="text-button danger-text" onClick={() => setConfirmRemove(true)}>移除连接</button>
        </div>
        {confirmRemove && <div className="delete-confirm box-remove"><p>移除后不会再读取 box 状态，所有 box 保活也会停止。box 本身和里面的文件不受影响。</p><button className="button danger" disabled={removing} onClick={() => void remove()}>确认移除</button><button className="button subtle" onClick={() => setConfirmRemove(false)}>取消</button></div>}
      </section>
      {data.error && <div className="notice error" role="alert">状态读取失败：{data.error} 保活仍会在后台按计划尝试。</div>}
      {!data.boxes.length ? <div className="empty"><HeartPulse size={30}/><h3>这个密钥下还没有 box</h3><p>到 box.simular.ai 创建一台后，刷新这里即可看到。</p></div> :
        <div className="box-grid">{data.boxes.map(box => {
          const policy = data.policies.find(item => item.boxId === box.boxId);
          return <article className={'box-card' + (policy && policy.mode !== 'off' ? ' keepalive' : '')} key={box.boxId}>
            <header><div className="box-title"><span className={'box-state ' + box.state}><span/>{box.state === 'running' ? '运行中' : box.state === 'hibernated' ? '已休眠' : box.state || '未知'}</span><strong>{box.name || box.boxId}</strong></div><span className={'box-policy' + (policy && policy.mode !== 'off' ? ' on' : '')}><HeartPulse size={13}/>{modeLabel(policy)}</span></header>
            <dl><div><dt>ID</dt><dd>{box.boxId}</dd></div><div><dt>镜像</dt><dd>{box.image || '—'}</dd></div></dl>
            {policy && policy.mode !== 'off' && <p className="box-last">{policy.lastCheckedAt ? '最近检查：' + new Date(policy.lastCheckedAt).toLocaleString('zh-CN') + ' · ' : ''}{policy.lastResult || '等待定时检查'}{policy.lastError && ' · ' + policy.lastError}</p>}
            <footer>
              {box.viewUrl && <a className="button compact" href={box.viewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/>打开画面</a>}
              <button className="button compact" onClick={() => setPolicyBox(box)}><HeartPulse size={14}/>{policy && policy.mode !== 'off' ? '修改保活' : '设置保活'}</button>
            </footer>
          </article>;
        })}</div>}
      <p className="box-footnote">定时任务每分钟运行一次；每台 box 的检查会复用保活预算，最多同时保活 {BOX_KEEPALIVE_MAX_BOXES} 台。最近调度：{data.lastRunAt ? ago(data.lastRunAt) : '尚未运行'}。</p>
    </>}
    {keyOpen && <KeyForm overview={data || { configured: false, label: '', keySuffix: '', enabled: false, intervalMinutes: 1, maxBoxes: BOX_KEEPALIVE_MAX_BOXES, boxes: [], policies: [], lastRunAt: null, error: '' }} close={() => setKeyOpen(false)} saved={value => { setData(value); notify('box 密钥已保存。'); }}/>}
    {policyBox && <PolicyForm box={policyBox} policy={data?.policies.find(item => item.boxId === policyBox.boxId)} close={() => setPolicyBox(null)} saved={value => { setData(value); notify('box 保活设置已保存。'); }}/>}
  </>;
}
