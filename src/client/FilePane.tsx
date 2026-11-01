import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Check, Download, File, Folder, FolderPlus, Home, Link, LoaderCircle, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api, ApiError } from './api';
import { downloadFile, uploadFile } from './file-api';
import { baseName, fileName, filePath, fileSize, joinPath, maxMultipartBytes, maxUploadBytes, parentPath, type FileEntry, type FileView } from '../shared/files';
import { cleanupUpload, pendingUploads, type PendingUpload } from './multipart-api';
import { Modal, type MachineRow } from './App';
import './files.css';

type Edit = { kind: 'mkdir' | 'rename' | 'delete'; path: string; name: string; directory: boolean; confirm: string };
type UploadItem = { id: number; file: globalThis.File; path: string; parents: boolean; state: 'waiting' | 'sending' | 'done' | 'conflict' | 'failed' | 'uncertain'; percent: number; message: string };
const errorText = (e: unknown) => e instanceof Error ? e.message : '请求未完成，请重试。';
const uncertain = (e: unknown) => !(e instanceof ApiError) || !e.status || e.status >= 500;

export default function FilePane({ row, onClose, onAuthError }: { row: MachineRow; onClose: () => void; onAuthError: (e: unknown) => void }) {
  const [accountId, setAccountId] = useState(row.account.id);
  const [path, setPath] = useState('/data/home'), [address, setAddress] = useState('/data/home');
  const [data, setData] = useState<FileView | null>(null), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null), [uploadOpen, setUploadOpen] = useState(false);
  const [destination, setDestination] = useState('/data/home'), [parents, setParents] = useState(false);
  const [selected, setSelected] = useState<globalThis.File[]>([]), [queue, setQueue] = useState<UploadItem[]>([]);
  const [retained, setRetained] = useState<PendingUpload[]>([]);
  const mounted = useRef(true), lock = useRef(false), stop = useRef(false), transfer = useRef<AbortController | null>(null);
  const account = row.sources.find(a => a.id === accountId);
  const base = '/api/accounts/' + accountId + '/machines/' + row.machine.id + '/files';
  useEffect(() => { const refresh = () => setRetained(pendingUploads(base)); refresh(); window.addEventListener('panel-upload-change', refresh); return () => window.removeEventListener('panel-upload-change', refresh); }, [base]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true; transfer.current?.abort(); }; }, []);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    void api<FileView>(base + '?' + new URLSearchParams({ path }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) })
      .then(value => { if (!stopped) { setData(value); setAddress(value.path); setLoadError(''); } })
      .catch(e => { if (!stopped) { setLoadError(errorText(e)); onAuthError(e); } })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [base, path, revision, onAuthError]);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  const canAct = !!data && !loading && !busy && !loadError && !!account?.enabled;
  function navigate(value: string) {
    if (lock.current) return;
    try { const next = filePath(value); setPath(next); setAddress(next); setData(null); setEdit(null); setLoadError(''); setError(''); setNotice(''); setRevision(v => v + 1); }
    catch (e) { setError(errorText(e)); }
  }
  function selectAccount(id: string) {
    if (lock.current || id === accountId) return;
    setAccountId(id); setData(null); setLoading(true); setLoadError(''); setError(''); setNotice(''); setEdit(null); setUploadOpen(false); setQueue([]); setSelected([]);
  }
  function openEdit(kind: Edit['kind'], entry?: FileEntry) {
    if (!data || !canAct) return;
    try {
      setEdit({ kind, path: entry ? joinPath(data.path, entry.name) : data.path, name: entry?.name || '', directory: entry?.type === 'dir', confirm: '' });
      setError(''); setNotice('');
    } catch (e) { setError(errorText(e)); }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !canAct || lock.current) return;
    let requestPath = base, method = 'POST', body: unknown;
    try {
      if (edit.kind === 'mkdir') { requestPath += '/directory'; body = { path: joinPath(edit.path, fileName(edit.name)) }; }
      else if (edit.kind === 'rename') { method = 'PATCH'; body = { path: edit.path, name: fileName(edit.name) }; }
      else { method = 'DELETE'; body = { path: edit.path, recursive: edit.directory, confirmPath: edit.confirm }; }
    } catch (e) { setError(errorText(e)); return; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api(requestPath, { method, body });
      if (mounted.current) { setEdit(null); setNotice(edit.kind === 'mkdir' ? '目录已创建。' : edit.kind === 'rename' ? '已重命名。' : '已删除。'); }
    } catch (e) {
      if (mounted.current) { setError(errorText(e) + (uncertain(e) ? ' 结果尚未确认，请核对刷新后的目录再操作。' : '')); onAuthError(e); }
    } finally {
      lock.current = false;
      if (mounted.current) { setBusy(false); setRevision(v => v + 1); }
    }
  }
  async function download(path: string) {
    try { await downloadFile(base, path); } catch (e) { setError(errorText(e)); onAuthError(e); }
  }
  function updateItem(id: number, change: Partial<UploadItem>) {
    if (mounted.current) setQueue(items => items.map(item => item.id === id ? { ...item, ...change } : item));
  }
  async function send(items: UploadItem[], overwrite = false) {
    if (lock.current || !account?.enabled) return;
    lock.current = true; stop.current = false; setBusy(true); setError(''); setNotice('');
    try {
      for (const item of items) {
        if (stop.current || !mounted.current) break;
        const controller = new AbortController(); transfer.current = controller;
        updateItem(item.id, { state: 'sending', percent: 0, message: '' });
        try {
          await uploadFile(base, item.file, item.path, item.parents, overwrite, controller.signal, (percent, message) => updateItem(item.id, { percent, message: message || '' }));
          updateItem(item.id, { state: 'done', percent: 100, message: '上传完成' });
        } catch (e) {
          const state = e instanceof ApiError && e.code === 'file_exists' ? 'conflict' : uncertain(e) ? 'uncertain' : 'failed';
          updateItem(item.id, { state, message: errorText(e) });
          if (mounted.current) onAuthError(e);
          if (e instanceof ApiError && e.status === 401) stop.current = true;
        } finally { transfer.current = null; }
      }
    } finally {
      lock.current = false;
      if (mounted.current) { setBusy(false); setRevision(v => v + 1); }
    }
  }
  function beginUpload(event: FormEvent) {
    event.preventDefault();
    if (!canAct || !selected.length) return;
    try {
      const folder = filePath(destination);
      if (selected.some(f => f.size > maxMultipartBytes)) throw new Error('单个文件最多 20 GiB，请重新选择。');
      if (new Set(selected.map(f => f.name)).size !== selected.length) throw new Error('本次选择中有重复文件名，请分批上传。');
      const items: UploadItem[] = selected.map((file, id) => ({ id, file, path: joinPath(folder, file.name), parents, state: 'waiting', percent: 0, message: '' }));
      setQueue(items); void send(items);
    } catch (e) { setError(errorText(e)); }
  }
  async function clean(record: PendingUpload) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await cleanupUpload(record); setNotice('临时分片已清理，目标文件不受影响。');
      setQueue(items => items.map(item => item.path === record.path && item.file.size === record.size ? { ...item, state: 'waiting', percent: 0, message: '' } : item));
    }
    catch (e) { setError(errorText(e)); onAuthError(e); }
    finally { lock.current = false; if (mounted.current) { setBusy(false); setRevision(v => v + 1); } }
  }
  const current = data?.path || path;
  return <Modal title={row.machine.name + ' · 文件管理'} wide onClose={() => { if (!lock.current) onClose(); }}><div className="file-pane">
    <div className="file-toolbar"><p className="dialog-description">浏览机器文件，或上传到指定目录。</p><div>
      <button className="button compact" disabled={loading || busy} onClick={() => setRevision(v => v + 1)}><RefreshCw size={14} className={loading ? 'spin' : ''}/>刷新目录</button>
      <button className="button compact" disabled={!canAct || data.type !== 'dir'} onClick={() => openEdit('mkdir')}><FolderPlus size={15}/>新建目录</button>
      <button className="button primary compact" disabled={!canAct} onClick={() => { if (!data) return; setUploadOpen(true); if (!queue.length) setDestination(data.type === 'dir' ? data.path : parentPath(data.path)); setEdit(null); }}><Upload size={15}/>上传文件</button>
    </div></div>
    {row.sources.length > 1 ? <label className="file-account">操作账号<select aria-label="文件操作账号" disabled={busy} value={accountId} onChange={e => selectAccount(e.target.value)}>{row.sources.map(a => <option key={a.id} value={a.id} disabled={!a.enabled}>{a.label}</option>)}</select></label> : <p className="field-help">操作账号：{account?.label || row.account.label}</p>}
    {row.machine.state !== 'running' && <div className="notice">文件访问需要运行中的机器。因空闲而暂停的机器可能由平台自动恢复，其他情况请先启动或恢复机器。</div>}
    {!account?.enabled && <div className="notice">此账号已停用或移除，请切换账号。</div>}
    <form className="file-address" onSubmit={e => { e.preventDefault(); navigate(address); }}>
      <button className="icon-button" type="button" title="主目录" aria-label="文件主目录" disabled={busy} onClick={() => navigate('/data/home')}><Home size={17}/></button>
      <button className="icon-button" type="button" title="上一级" aria-label="上一级目录" disabled={busy || current === '/'} onClick={() => navigate(parentPath(current))}><ArrowUp size={17}/></button>
      <input aria-label="文件路径" value={address} onChange={e => setAddress(e.target.value)} disabled={busy} spellCheck={false}/><button className="button compact" disabled={busy}>前往</button>
    </form>
    {loadError && <div className="notice error" role="alert">{loadError} 请刷新或更换路径后重试。</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice success" role="status"><Check size={16}/>{notice}</div>}
    {edit && <form className={'file-form' + (edit.kind === 'delete' ? ' file-delete' : '')} onSubmit={saveEdit}>
      <h3>{edit.kind === 'mkdir' ? '新建目录' : edit.kind === 'rename' ? '重命名' : '确认删除'}</h3><p className="file-target">{edit.path}</p>
      {edit.kind === 'delete' ? <><p>删除后无法撤销。{edit.directory ? '目录中的所有文件和子目录也会删除。' : '符号链接只删除链接本身。'}</p><label>输入完整路径确认<input autoFocus value={edit.confirm} disabled={busy} onChange={e => setEdit({ ...edit, confirm: e.target.value })}/></label></> : <label>{edit.kind === 'mkdir' ? '目录名称' : '新名称'}<input autoFocus required value={edit.name} disabled={busy} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label>}
      <div className="file-buttons"><button className={'button ' + (edit.kind === 'delete' ? 'danger' : 'primary')} disabled={!canAct || (edit.kind === 'delete' && edit.confirm !== edit.path)}>{busy ? '处理中…' : edit.kind === 'mkdir' ? '创建目录' : edit.kind === 'rename' ? '保存名称' : '确认删除'}</button><button type="button" className="button subtle" disabled={busy} onClick={() => setEdit(null)}>取消</button></div>
    </form>}
    {uploadOpen && <section className="file-form file-upload"><div className="file-section-heading"><h3>上传到指定目录</h3><button className="icon-button" aria-label="收起上传" disabled={busy} onClick={() => setUploadOpen(false)}><X size={17}/></button></div>
      <form onSubmit={beginUpload}><label>目标目录<input required value={destination} disabled={busy || queue.length > 0} placeholder="/data/home/uploads" spellCheck={false} onChange={e => setDestination(e.target.value)}/></label>
        <label>选择文件<input type="file" multiple disabled={busy} onChange={e => { setSelected(Array.from(e.target.files || [])); setQueue([]); setError(''); }}/></label>
        <label className="checkbox-label"><input type="checkbox" checked={parents} disabled={busy || queue.length > 0} onChange={e => setParents(e.target.checked)}/>自动创建不存在的目录</label>
        <p className="field-help">单个文件最多 20 GiB。超过 95 MiB 会自动分片，上传后合并校验。同名文件需要逐个确认覆盖；中断后重新选择原文件可续传。</p>
        <div className="file-buttons"><button className="button primary" disabled={!canAct || !selected.length || queue.length > 0}><Upload size={15}/>开始上传{selected.length > 0 ? '（' + selected.length + '）' : ''}</button>
          {busy && transfer.current && <button className="button" type="button" onClick={() => { stop.current = true; transfer.current?.abort(); }}>取消上传</button>}
          {!!queue.length && !busy && <button className="button subtle" type="button" onClick={() => setQueue([])}>重新准备上传</button>}</div>
      </form>
      <div className="file-upload-list" aria-live="polite">{queue.map(item => <article className="file-upload-item" key={item.id}>
        <strong>{item.file.name}<small>{fileSize(item.file.size)}</small></strong><p className="file-target">{item.path}</p>
        <div className="file-upload-status"><span>{item.state === 'sending' ? item.message || (item.percent < 100 ? '上传中 ' + item.percent + '%' : '等待服务器确认…') : item.state === 'waiting' ? '尚未上传' : item.message}</span>
          {!busy && item.state === 'conflict' && <button className="button danger compact" disabled={!canAct} onClick={() => void send([item], true)}>确认覆盖</button>}
          {!busy && ['failed', 'uncertain', 'waiting'].includes(item.state) && <button className="button compact" disabled={!canAct} onClick={() => void send([item])}>{item.state === 'waiting' ? '上传此文件' : item.file.size > maxUploadBytes ? '继续上传' : '重新上传'}</button>}</div>
        {item.state === 'uncertain' && <p className="field-help">请先刷新并核对目标文件，再决定是否重传。</p>}
        {item.state === 'sending' && <progress aria-label={item.file.name + ' 上传进度'} max={100} value={item.percent}/>}</article>)}</div>
    </section>}
    {!!retained.length && <section className="file-form file-retained"><h3>保留的上传任务</h3><p className="field-help">重新选择原文件并使用相同目标目录即可续传。清理只移除临时分片；正在合并时需等待合并结束。</p>{retained.map(record => <article className="file-upload-item" key={record.id}><strong>{record.name}<small>{fileSize(record.size)}</small></strong><p className="file-target">{record.path}</p><button className="button compact" disabled={busy || !account?.enabled} onClick={() => void clean(record)}>清理分片</button></article>)}</section>}
    {loading && <div className="file-loading" role="status"><LoaderCircle size={16} className="spin"/>正在读取文件…</div>}
    {data && <><div className="file-summary"><span>{data.type === 'dir' ? data.entries.length + ' 个项目' : fileSize(data.size)}</span><code>{data.mode}</code><span>{new Date(data.modTime).toLocaleString('zh-CN')}</span></div>
      {data.truncated && <div className="notice">{data.type === 'dir' ? '仅展示前 5000 个项目；可以在路径栏输入完整路径访问其他项目。' : '仅预览前 256 KiB，下载可获取完整内容。'}</div>}
      {data.type === 'dir' ? <div className="file-list">{!data.entries.length && <div className="file-empty"><Folder size={30}/><p>此目录为空</p></div>}{data.entries.map(entry => {
        let entryPath = ''; try { entryPath = joinPath(data.path, entry.name); } catch { /* Unusual Unix names remain visible but cannot be operated on. */ }
        return <article className="file-row" key={entry.name} data-file={entry.name}>
          <button className="file-open" disabled={!canAct || !entryPath || entry.type === 'other'} onClick={() => navigate(entryPath)}>{entry.type === 'dir' ? <Folder size={20}/> : entry.type === 'symlink' ? <Link size={19}/> : <File size={19}/>}<span><strong>{entry.name}</strong><small>{entry.type === 'dir' ? '目录' : entry.type === 'symlink' ? '链接 → ' + entry.target : fileSize(entry.size)} · {entry.mode}</small></span></button>
          <div className="file-row-actions">{entry.type === 'file' && <button className="icon-button" aria-label={'下载 ' + entry.name} title="下载" disabled={!canAct || !entryPath} onClick={() => void download(entryPath)}><Download size={16}/></button>}<button className="icon-button" aria-label={'重命名 ' + entry.name} title="重命名" disabled={!canAct || !entryPath} onClick={() => openEdit('rename', entry)}><Pencil size={16}/></button><button className="icon-button danger-text" aria-label={'删除 ' + entry.name} title="删除" disabled={!canAct || !entryPath} onClick={() => openEdit('delete', entry)}><Trash2 size={16}/></button></div>
        </article>;
      })}</div> : data.type === 'file' ? <section className="file-preview"><div className="file-section-heading"><h3>{baseName(data.path)}</h3><button className="button compact" disabled={!canAct} onClick={() => void download(data.path)}><Download size={15}/>下载文件</button></div>{data.binary ? <p className="file-empty">二进制文件，请下载后查看。</p> : <pre tabIndex={0}>{data.content || '（空文件）'}</pre>}</section> : <div className="notice">此路径为特殊文件，暂不支持预览或下载。</div>}
    </>}
  </div></Modal>;
}
