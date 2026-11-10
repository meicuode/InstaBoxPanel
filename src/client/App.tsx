import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Activity, Archive, FolderOpen, Monitor, Network, ArrowUpRight, Box, Boxes, Check, ChevronRight, CircleAlert, Clock3, Ellipsis, HeartPulse, Layers3, LoaderCircle, LogOut, Pause, Play, Plus, RefreshCw, Search, Send, Server, ShieldCheck, Square, TerminalSquare, X } from 'lucide-react';
import { api, ApiError, concurrent, isDemo } from './api';
import { actionLabels, actionSourceLabels, stateLabels, type Account, type AccountMachines, type Action, type ActionType, type Machine, type Session } from '../shared/types';
import AuthScreen from './AuthScreen';
import KeepaliveForm from './KeepaliveForm';
import TelegramForm from './TelegramForm';
import BoxPanel from './BoxPanel';
import type { KeepaliveOverview } from '../shared/keepalive';
import { usePanelRoute } from './usePanelRoute';
import { useTerminalWindows } from './useTerminalWindows';
import TerminalDock from './TerminalDock';
const TerminalPane = lazy(() => import('./TerminalPane'));
const DesktopPane = lazy(() => import('./DesktopPane'));
const SnapshotPane = lazy(() => import('./SnapshotPane'));
const PortPane = lazy(() => import('./PortPane'));
const FilePane = lazy(() => import('./FilePane'));

interface Snapshot extends Partial<AccountMachines> { error?: string; failures?: number; retryAt?: number }
export interface MachineRow { machine: Machine; account: Account; sources: Account[]; checkedAt: string; stale: boolean }
const pending = (a: Action) => ['submitting', 'queued', 'running'].includes(a.state);
const unresolved = (a: Action) => pending(a) || a.state === 'unknown';
const message = (e: unknown) => e instanceof Error ? e.message : '请求未完成，请重试。';
function ago(value?: string) {
  if (!value) return '尚未查询';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  return s < 5 ? '刚刚' : s < 60 ? s + ' 秒前' : Math.floor(s / 60) + ' 分钟前';
}
function merge(rows: Action[], next: Action) {
  const old = rows.find(a => a.id === next.id);
  if (old && !unresolved(old) && unresolved(next)) return rows;
  return [next, ...rows.filter(a => a.id !== next.id)].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId=useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el=ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={'modal ' + (wide ? 'modal-wide' : '')} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}
function AccountForm({ current, close, saved }: { current: Account | null; close: () => void; saved: () => Promise<void> }) {
  const [label,setLabel]=useState(current?.label||''), [key,setKey]=useState(''), [enabled,setEnabled]=useState(current?.enabled??true);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[remove,setRemove]=useState(false);
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(current?'/api/accounts/'+current.id:'/api/accounts',{method:current?'PATCH':'POST',body:{label,enabled,...(!current||key?{apiKey:key}:{})}});setKey('');await saved();close(); }
    catch(e){setError(message(e));}finally{setBusy(false);}
  }
  async function erase() {
    setBusy(true);setError('');
    try{await api('/api/accounts/'+current!.id,{method:'DELETE',body:{}});await saved();close();}catch(e){setError(message(e));}finally{setBusy(false);}
  }
  return <Modal title={current?'管理账号':'添加账号'} onClose={()=>{if(!busy)close();}}>
    <p className="dialog-description">{current?'修改别名、替换凭据，或暂停这个账号的同步。':'连接你的 InstaBox 账号，统一查看和控制机器。'}</p>
    {isDemo&&<div className="notice"><CircleAlert size={17}/><span>当前为演示模式，请使用示例密钥 <code>ibk_demo_example</code>。</span></div>}
    <form onSubmit={save} className="account-form">
      <label>账号别名<input autoFocus value={label} maxLength={60} required placeholder="例如：主账号、实验室" onChange={e=>setLabel(e.target.value)} disabled={busy}/></label>
      <label>{current?'替换 API Key':'API Key'}<input type="password" autoComplete="new-password" spellCheck={false} value={key} required={!current} placeholder={current?'留空保留现有 Key':'ibk_…'} onChange={e=>setKey(e.target.value)} disabled={busy}/></label>
      <p className="field-help">在 InstaBox 的 Profile → API keys 创建专用 Key，授予 <code>machines:write</code> 权限。快照另需 <code>images:read</code>、<code>images:write</code> 和 <code>images:delete</code>。保存后不再展示完整凭据。</p>
      {current&&<label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={busy}/>启用账号同步与机器控制</label>}
      {error&&<div className="notice error" role="alert">{error}</div>}
      {remove&&<div className="delete-confirm"><p>移除“{current?.label}”及其连接凭据？InstaBox 上的机器会继续保留。</p><button type="button" className="button danger" disabled={busy} onClick={erase}>确认移除</button><button type="button" className="button subtle" onClick={()=>setRemove(false)}>取消</button></div>}
      <div className="dialog-footer">{current&&<button type="button" className="text-button danger-text" disabled={busy} onClick={()=>setRemove(true)}>移除账号</button>}<button className="button primary" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>} {busy?'验证并保存…':'保存账号'}</button></div>
    </form>
  </Modal>;
}
export default function App(){
  const [session,setSession]=useState<Session|null>(null),[error,setError]=useState('');
  const refreshSession=useCallback(async()=>{
    setError('');
    try{setSession(await api<Session>('/api/session'));}catch(error){setError(message(error));}
  },[]);
  useEffect(()=>{void refreshSession();},[refreshSession]);
  const signedOut=useCallback(()=>setSession({username:'',authenticated:false,setupRequired:false,demo:isDemo}),[]);
  if(error)return <main className="access-screen"><span className="brand-mark"><Box/></span><h1>连接私人控制台</h1><p role="alert">{error}</p><button className="button primary" onClick={()=>void refreshSession()}><RefreshCw size={16}/>重试连接</button></main>;
  if(!session)return <main className="access-screen"><LoaderCircle size={26} className="spin"/><p>正在连接控制台…</p></main>;
  if(!session.authenticated)return <AuthScreen status={session} onAuthenticated={setSession} refresh={refreshSession}/>;
  return <Dashboard session={session} signedOut={signedOut}/>;
}
function Dashboard({session,signedOut}:{session:Session;signedOut:()=>void}){
  const {route,navigate,link}=usePanelRoute();
  const selected=route.selected,history=route.view==='history',telegramOpen=route.view==='telegram',boxOpen=route.view==='box';
  const setSelected=(selected:string)=>navigate({view:'machines',selected});
  const setHistory=(open:boolean)=>navigate({view:open?'history':'machines',selected},!open);
  const setTelegramOpen=(open:boolean)=>navigate({view:open?'telegram':'machines',selected},!open);
  const terminalWindows=useTerminalWindows();
  const desktopWindows=useTerminalWindows();
  const [activeSurface,setActiveSurface]=useState<'terminal'|'desktop'>('terminal');
  const remoteSlots=useRef(new Set<string>());
  remoteSlots.current=new Set([...terminalWindows.windows.map(item=>'terminal:'+item.row.machine.id),...desktopWindows.windows.map(item=>'desktop:'+item.row.machine.id)]);
  const [fileRow,setFileRow]=useState<MachineRow|null>(null);
  const [portRow,setPortRow]=useState<MachineRow|null>(null);
  const [snapshotTarget,setSnapshotTarget]=useState<{account:Account;row?:MachineRow}|null>(null);
  const [fatal,setFatal]=useState('');
  const [accounts,setAccounts]=useState<Account[]>([]),[snapshots,setSnapshots]=useState<Record<string,Snapshot>>({}),[actions,setActions]=useState<Action[]>([]);
  const accountsRef=useRef(accounts);accountsRef.current=accounts;
  const snapshotsRef=useRef(snapshots);snapshotsRef.current=snapshots;
  const seq=useRef<Record<string,number>>({}),refreshLock=useRef(false),submitLock=useRef(new Set<string>());
  const [loaded,setLoaded]=useState(false),[refreshing,setRefreshing]=useState(false),[filter,setFilter]=useState('all'),[search,setSearch]=useState('');
  const [form,setForm]=useState<Account|'new'|null>(null),[detail,setDetail]=useState<MachineRow|null>(null);
  const [keepalive,setKeepalive]=useState<KeepaliveOverview>({intervalMinutes:1,maxMachines:5,policies:[],lastRunAt:null}),[keepaliveRow,setKeepaliveRow]=useState<MachineRow|null>(null);
  const [submitting,setSubmitting]=useState(new Set<string>()),[toast,setToast]=useState<{text:string;error:boolean}|null>(null),[progressError,setProgressError]=useState('');
  const [visible,setVisible]=useState(!document.hidden),[tick,setTick]=useState(0);
  const notify=useCallback((text:string,error=false)=>setToast({text,error}),[]);
  const authError=useCallback((e:unknown)=>{if(e instanceof ApiError&&e.code==='authentication_required')signedOut();},[signedOut]);
  const refreshOne=useCallback(async(a:Account)=>{
    const ticket=(seq.current[a.id]||0)+1;seq.current[a.id]=ticket;
    try{
      const data=await api<AccountMachines>('/api/accounts/'+a.id+'/machines');
      if(seq.current[a.id]===ticket)setSnapshots(p=>({...p,[a.id]:{...data,failures:0}}));
    }catch(e){
      authError(e);if(seq.current[a.id]!==ticket)return;
      setSnapshots(p=>{const failures=(p[a.id]?.failures||0)+1;return {...p,[a.id]:{...p[a.id],error:message(e),failures,retryAt:Date.now()+Math.min(60000,10000*2**Math.min(failures-1,3))}};});
    }
  },[authError]);
  const refresh=useCallback(async(force=false)=>{
    if(refreshLock.current)return;
    refreshLock.current=true;setRefreshing(true);
    try{await concurrent(accountsRef.current.filter(a=>a.enabled&&(force||(snapshotsRef.current[a.id]?.retryAt||0)<=Date.now())),refreshOne);}
    finally{refreshLock.current=false;setRefreshing(false);}
  },[refreshOne]);
  const reloadAccounts=useCallback(async()=>{
    const r=await api<{accounts:Account[]}>('/api/accounts');accountsRef.current=r.accounts;setAccounts(r.accounts);
    await refresh(true);
  },[refresh]);
  useEffect(()=>{
    if(loaded&&selected!=='all'&&!accounts.some(account=>account.id===selected))navigate({...route,selected:'all'},true);
  },[loaded,accounts,selected,route,navigate]);
  useEffect(()=>{setFilter('all');setSearch('');},[selected]);
  useEffect(()=>{
    let cancelled=false;
    void(async()=>{try{
      const [a,b,automation]=await Promise.all([api<{accounts:Account[]}>('/api/accounts'),api<{actions:Action[]}>('/api/actions'),api<KeepaliveOverview>('/api/keepalive')]);if(cancelled)return;
      accountsRef.current=a.accounts;setAccounts(a.accounts);setActions(b.actions);setKeepalive(automation);await refresh(true);if(!cancelled)setLoaded(true);
    }catch(e){if(!cancelled){authError(e);setFatal(message(e));}}})();
    return()=>{cancelled=true;};
  },[refresh,authError]);
  useEffect(()=>{
    const timer=setInterval(()=>{if(!document.hidden){void api<KeepaliveOverview>('/api/keepalive').then(setKeepalive).catch(authError);void api<{actions:Action[]}>('/api/actions').then(value=>setActions(value.actions)).catch(authError);}},60000);
    return()=>clearInterval(timer);
  },[authError]);
  useEffect(()=>{
    if(!session||fatal)return;
    const timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);
    const clock=setInterval(()=>setTick(t=>t+1),5000);
    const visibility=()=>{setVisible(!document.hidden);if(!document.hidden){void refresh(true);void api<{actions:Action[]}>('/api/actions').then(r=>setActions(r.actions)).catch(authError);}};
    document.addEventListener('visibilitychange',visibility);
    return()=>{clearInterval(timer);clearInterval(clock);document.removeEventListener('visibilitychange',visibility);};
  },[session,fatal,refresh,authError]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(null),toast.error?9000:4500);return()=>clearTimeout(t);},[toast]);
  const pollKey=actions.filter(pending).slice(0,3).map(a=>a.id).join(',');
  useEffect(()=>{
    if(!pollKey||!visible||fatal)return;
    const abort=new AbortController();
    for(const id of pollKey.split(','))void(async()=>{
      while(!abort.signal.aborted){
        try{
          const {action:a}=await api<{action:Action}>('/api/actions/'+id+'?wait=25',{signal:abort.signal});if(abort.signal.aborted)break;
          setProgressError('');setActions(p=>merge(p,a));
          if(!pending(a)){const account=accountsRef.current.find(x=>x.id===a.accountId);if(account?.enabled)await refreshOne(account);if(a.state==='succeeded')notify(a.machineName+' · '+actionLabels[a.type]+'完成');if(a.state==='failed')notify(a.errorMessage||'操作失败。',true);break;}
          await new Promise(r=>setTimeout(r,1000));
        }catch(e){if(abort.signal.aborted)break;authError(e);setProgressError('进度暂时无法获取，正在重试；操作结果尚未确认。');await new Promise(r=>setTimeout(r,5000));}
      }
    })();
    return()=>abort.abort();
  },[pollKey,visible,fatal,refreshOne,notify,authError]);
  const rows=useMemo(()=>{
    const map=new Map<string,MachineRow>();
    for(const account of accounts.filter(a=>a.enabled&&(selected==='all'||selected===a.id))){
      const s=snapshots[account.id];if(!s?.machines)continue;
      for(const machine of s.machines.filter(m=>m.state!=='deleted')){
        const next:MachineRow={machine,account,sources:[account],checkedAt:s.checkedAt||'',stale:Boolean(s.error)||Date.now()-Date.parse(s.checkedAt||'')>30000};
        const old=map.get(machine.id);
        if(!old)map.set(machine.id,next);
        else{const winner=(old.stale&&!next.stale)||(old.stale===next.stale&&next.checkedAt>old.checkedAt)?next:old;map.set(machine.id,{...winner,sources:[...old.sources,account]});}
      }
    }
    return [...map.values()].sort((a,b)=>a.machine.name.localeCompare(b.machine.name));
  },[accounts,snapshots,selected,tick]);
  const shown=rows.filter(r=>(filter==='all'||r.machine.state===filter)&&(r.machine.name+r.machine.id+r.account.label).toLowerCase().includes(search.trim().toLowerCase()));
  const errors=accounts.filter(a=>a.enabled&&(selected==='all'||selected===a.id)&&snapshots[a.id]?.error);
  const busyMap=new Map(actions.filter(unresolved).map(a=>[a.machineId,a]));
  const total=new Set(accounts.filter(a=>a.enabled).flatMap(a=>(snapshots[a.id]?.machines||[]).map(m=>m.id))).size;
  async function change(row:MachineRow,type:ActionType,retry?:Action){
    if(submitLock.current.has(row.machine.id))return;
    submitLock.current.add(row.machine.id);setSubmitting(new Set(submitLock.current));const requestId=retry?.id||crypto.randomUUID();
    try{
      const {action:a}=await api<{action:Action}>('/api/accounts/'+row.account.id+'/machines/'+row.machine.id+'/actions',{method:'POST',body:{type,requestId}});
      setActions(p=>merge(p,a));
      if(a.state==='failed'){notify(a.errorMessage||'操作失败。',true);setHistory(true);}
      else if(a.state==='unknown'){notify('结果待确认，请在操作记录中使用原请求重试。',true);setHistory(true);}
      else notify(a.state==='succeeded'?'操作已完成。':'已提交'+actionLabels[type]+'请求，正在确认结果。');
      await refreshOne(row.account);
    }catch(e){
      authError(e);notify(message(e),true);
      if(e instanceof ApiError&&(e.code==='network_error'||e.status>=500)){
        const a:Action={id:requestId,accountId:row.account.id,machineId:row.machine.id,machineName:row.machine.name,type,source:retry?.source||'web',state:'unknown',operationId:null,phase:'',errorCode:e.code,errorMessage:'连接中断，结果尚未确认。重试会复用原请求。',createdAt:retry?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),processesPreserved:null};
        setActions(p=>merge(p,a));setHistory(true);
      }
    }finally{submitLock.current.delete(row.machine.id);setSubmitting(new Set(submitLock.current));}
  }
  function retry(a:Action){
    const account=accounts.find(x=>x.id===a.accountId);if(!account?.enabled){notify('请先启用并恢复原账号的连接。',true);return;}
    const machine=snapshots[account.id]?.machines?.find(m=>m.id===a.machineId)||{id:a.machineId,name:a.machineName} as Machine;
    void change({account,machine,sources:[account],checkedAt:'',stale:true},a.type,a);
  }
  function control(r:MachineRow){
    const busy=busyMap.get(r.machine.id);
    if(submitting.has(r.machine.id)||(busy&&pending(busy)))return <button className="button compact subtle" disabled><LoaderCircle size={14} className="spin"/>处理中</button>;
    if(busy?.state==='unknown')return <button className="button compact" onClick={()=>setHistory(true)}><CircleAlert size={14}/>待确认</button>;
    const type=r.machine.state==='running'?'suspend':r.machine.state==='suspended'?'resume':r.machine.state==='stopped'?'start':null;
    if(!type||r.machine.operationId)return <span className="muted operation-hint">等待操作完成</span>;
    return <button className={'button compact '+(type==='suspend'?'':'resume-button')} disabled={r.stale} onClick={()=>void change(r,type)}>{type==='suspend'?<Pause size={14}/>:<Play size={14}/>} {actionLabels[type]}</button>;
  }
  const latest=(row:MachineRow):MachineRow=>{
    const account=accounts.find(item=>item.id===row.account.id);
    const snapshot=snapshots[row.account.id];
    const machine=snapshot?.machines?.find(item=>item.id===row.machine.id);
    return {...row,sources:row.sources.map(source=>accounts.find(item=>item.id===source.id)||{...source,enabled:false}),account:account||{...row.account,enabled:false},machine:machine||row.machine,
      checkedAt:snapshot?.checkedAt||row.checkedAt,stale:!account||Boolean(snapshot?.error)||Date.now()-Date.parse(snapshot?.checkedAt||'')>30000};
  };
  function openTerminal(row:MachineRow){
    const key='terminal:'+row.machine.id;
    if(!remoteSlots.current.has(key)&&remoteSlots.current.size>=8){notify('终端和远程桌面合计最多保留 8 个窗口，请先断开一个连接。',true);return;}
    remoteSlots.current.add(key);setActiveSurface('terminal');
    terminalWindows.open(row);
  }
  function openDesktop(row:MachineRow){
    const key='desktop:'+row.machine.id;
    if(!remoteSlots.current.has(key)&&remoteSlots.current.size>=8){notify('终端和远程桌面合计最多保留 8 个窗口，请先断开一个连接。',true);return;}
    remoteSlots.current.add(key);setActiveSurface('desktop');desktopWindows.open(row);
  }
  async function logout(){
    try{await Promise.allSettled(desktopWindows.windows.map(({row})=>api('/api/accounts/'+row.account.id+'/machines/'+row.machine.id+'/desktop',{method:'POST',body:{action:'handback'},signal:AbortSignal.timeout(3000)})));await api('/api/auth/logout',{method:'POST',body:{}});signedOut();}catch(error){authError(error);notify(message(error),true);}
  }
  if(fatal)return <main className="access-screen"><span className="brand-mark"><Box/></span><h1>连接私人控制台</h1><p role="alert">{fatal}</p><button className="button primary" onClick={()=>location.reload()}><RefreshCw size={16}/>重试连接</button></main>;
  return <div className="app-shell">
    <aside className="sidebar">
      <a {...link({view:'machines',selected:'all'})} className="brand"><span className="brand-mark"><Box size={23}/></span><span>instabox<span className="brand-sub">PANEL</span></span></a>
      <div className="workspace-label"><span className="workspace-avatar">{session.username[0]?.toUpperCase()||'I'}</span><div><strong>私人工作空间</strong><small>只属于你的控制台</small></div><ShieldCheck size={17}/></div>
      <div className="sidebar-caption">工作空间</div>
      <a {...link({view:'machines',selected:'all'})} className={'nav-item '+(selected==='all'&&route.view==='machines'?'selected':'')} aria-current={selected==='all'&&route.view==='machines'?'page':undefined}><Layers3 size={18}/><span>全部机器</span><span className="nav-count">{total}</span></a>
      <a {...link({view:'box',selected})} className={'nav-item box-nav '+(boxOpen?'selected':'')} aria-current={boxOpen?'page':undefined}><Boxes size={18}/><span>box panel</span></a>
      <a {...link({view:'history',selected})} className={'nav-item '+(history?'selected':'')} aria-current={history?'page':undefined}><Activity size={18}/><span>操作记录</span>{actions.some(unresolved)&&<span className="nav-count">{actions.filter(unresolved).length}</span>}</a>
      <div className="sidebar-caption account-caption"><span>已连接账号 <span>{accounts.length}</span></span><button className="icon-button" aria-label="添加账号" onClick={()=>setForm('new')}><Plus size={17}/></button></div>
      <div className="account-nav">{accounts.map(a=><div key={a.id} className={'account-nav-row '+(selected===a.id&&route.view==='machines'?'selected':'')}><a {...link({view:'machines',selected:a.id})} className="account-select" aria-current={selected===a.id&&route.view==='machines'?'page':undefined}><span className={'connection-dot '+(!a.enabled?'disabled':snapshots[a.id]?.error?'bad':'good')}/><span><strong>{a.label}</strong><small>{a.enabled?a.login||a.email||'已接入':'已停用'}</small></span></a><button className="icon-button" aria-label={'管理账号 '+a.label} onClick={()=>setForm(a)}><Ellipsis size={18}/></button></div>)}</div>
      <button className="add-account" onClick={()=>setForm('new')}><Plus size={16}/>连接另一个账号</button>
      <div className="sidebar-bottom"><div className="protected"><ShieldCheck size={16}/>{isDemo?'本地演示空间':'私人访问已保护'}</div><div className="profile"><span className="profile-avatar">{session.username[0]?.toUpperCase()||'I'}</span><div><strong>{session.username}</strong><small>管理员</small></div><button className="icon-button" aria-label="退出登录" onClick={()=>void logout()}><LogOut size={16}/></button></div></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumb">工作空间<ChevronRight size={14}/><strong>{history?'操作记录':telegramOpen?'Telegram':boxOpen?'box panel':selected==='all'?'全部机器':accounts.find(a=>a.id===selected)?.label}</strong></div><div className="topbar-links"><a {...link({view:'box',selected})} className="text-button telegram-settings box-top-link" aria-label="box panel" aria-current={boxOpen?'page':undefined}><Boxes size={14}/><span className="box-top-full">box panel</span><span className="box-top-short">box</span></a><a {...link({view:'telegram',selected})} className="text-button telegram-settings" aria-label="Telegram 设置" aria-current={telegramOpen?'page':undefined}><Send size={14}/>Telegram</a><a className="official-link" href="https://dashboard.instabox.sh" target="_blank" rel="noreferrer">官方控制台<ArrowUpRight size={14}/></a><button className="icon-button mobile-logout" aria-label="退出登录" onClick={()=>void logout()}><LogOut size={16}/></button></div></header>
    <div className="content">
      {boxOpen?<BoxPanel onAuthError={authError} notify={notify}/>:<>
      {isDemo&&<div className="demo-banner"><span className="demo-dot"/><strong>演示模式</strong><span>示例账号与机器，按钮操作不会影响真实资源。</span></div>}
      <div className="page-heading"><div><div className="eyebrow">YOUR MACHINES, TOGETHER</div><h1>{selected==='all'?'机器总览':accounts.find(a=>a.id===selected)?.label}</h1><p>让每一台机器，都在掌握之中。</p></div><button className="button primary" onClick={()=>setForm('new')}><Plus size={17}/>添加账号</button></div>
      <div className="mobile-scope"><label>当前账号<select aria-label="当前账号" value={selected} onChange={e=>setSelected(e.target.value)}><option value="all">全部账号</option>{accounts.map(a=><option value={a.id} key={a.id}>{a.label}{a.enabled?'':'（已停用）'}</option>)}</select></label>{selected!=='all'&&<button className="button compact" onClick={()=>setForm(accounts.find(a=>a.id===selected)!)}>管理账号</button>}</div>
      <div className="stats"><div className="stat"><span className="stat-icon"><Server size={20}/></span><div><span className="stat-label">全部机器</span><strong>{rows.length}<small>台</small></strong></div><span className="stat-note">{accounts.filter(a=>a.enabled).length} 个账号已启用</span></div><div className="stat"><span className="stat-icon running"><Activity size={20}/></span><div><span className="stat-label">运行中</span><strong>{rows.filter(r=>!r.stale&&r.machine.state==='running').length}<small>台</small></strong></div><span className="stat-note">当前正在运行</span></div><div className="stat"><span className="stat-icon paused"><Pause size={20}/></span><div><span className="stat-label">已暂停</span><strong>{rows.filter(r=>!r.stale&&r.machine.state==='suspended').length}<small>台</small></strong></div><span className="stat-note">随时继续工作</span></div></div>
      {errors.map(a=><div className="notice error account-error" role="alert" key={a.id}><CircleAlert size={17}/><div><strong>{a.label} 暂时无法同步</strong><span>{snapshots[a.id].error} {snapshots[a.id].checkedAt?'上次成功查询：'+ago(snapshots[a.id].checkedAt)+'。':''}</span></div><button className="text-button" onClick={()=>setForm(a)}>管理账号</button></div>)}
      {progressError&&<div className="notice error" role="status">{progressError}</div>}
      {!!accounts.length&&<div className="resource-shortcuts"><span>快照库</span>{accounts.filter(a=>selected==='all'||a.id===selected).map(a=><button key={a.id} className="button compact" disabled={!a.enabled} onClick={()=>setSnapshotTarget({account:a})}><Archive size={14}/>{a.label} · 账号快照</button>)}</div>}
      <section className="machine-panel" aria-label="机器列表">
        <div className="panel-top"><div><h2>机器列表 <span>{shown.length}</span></h2><p>暂停保留工作现场，恢复后继续。</p></div><div className="refresh-area"><span className="sync-label"><span className={'connection-dot '+(visible?'good':'disabled')}/>{visible?'每 10 秒刷新':'后台刷新已暂停'}</span><button className="icon-button refresh-button" aria-label="刷新机器" disabled={refreshing} onClick={()=>void refresh(true)}><RefreshCw size={17} className={refreshing?'spin':''}/></button></div></div>
        <div className="toolbar"><div className="filter-tabs" aria-label="按状态筛选">{[['all','全部'],['running','运行中'],['suspended','已暂停'],['stopped','已停止']].map(([v,t])=><button key={v} className={filter===v?'active':''} aria-pressed={filter===v} onClick={()=>setFilter(v)}>{t}</button>)}</div><label className="search-box"><Search size={16}/><input aria-label="搜索机器" placeholder="搜索机器名称或 ID…" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
        {!loaded?<div className="empty"><LoaderCircle size={27} className="spin"/><h3>正在连接你的机器</h3></div>:!shown.length?<div className="empty"><span className="empty-icon"><Box size={30}/></span><h3>{!accounts.length?'连接你的第一个账号':!rows.length?'这里还没有机器':'没有匹配的机器'}</h3><p>{!accounts.length?'添加 InstaBox API Key，开始管理你的机器。':errors.length?'查询未完成，恢复连接后再刷新。':'切换账号或筛选条件，或到官方控制台创建机器。'}</p>{!accounts.length&&<button className="button primary" onClick={()=>setForm('new')}>添加账号</button>}</div>:
        <div className="table-wrap"><table className="machines"><thead><tr><th>机器</th><th>所属账号</th><th>运行状态</th><th>最近查询</th><th className="actions-cell">操作</th></tr></thead><tbody>{shown.map(r=><tr key={r.machine.id} data-machine={r.machine.name}>
          <td><div className="machine-name"><span className={'machine-icon '+(r.machine.state==='running'&&!r.stale?'on':'')}><Box size={20}/></span><div><button className="name-button" onClick={()=>setDetail(r)}>{r.machine.name}</button><small>{r.machine.spec.vcpus} vCPU<span>·</span>{r.machine.spec.memMiB/1024} GB 内存</small></div></div></td>
          <td><span className="account-pill">{r.account.label}</span>{r.sources.length>1&&<small className="source-count">另外 {r.sources.length-1} 个账号可访问</small>}</td>
          <td><span className={'state-badge '+(r.stale?'unknown':r.machine.state)}><span/>{r.stale?'数据已过期':stateLabels[r.machine.state]}</span>{r.stale?<small className="state-detail">上次：{stateLabels[r.machine.state]}</small>:r.machine.state==='running'&&!r.machine.runtime.ready?<small className="state-detail">等待服务就绪</small>:null}</td>
          <td className="last-checked"><Clock3 size={13}/>{ago(r.checkedAt)}</td>
          <td className="actions-cell"><div className="row-actions">{control(r)}<button className="icon-button" aria-label={'打开 '+r.machine.name+' 终端'} disabled={r.stale} onClick={()=>openTerminal(r)}><TerminalSquare size={17}/></button><button className="icon-button" title="远程桌面" aria-label={'打开 '+r.machine.name+' 远程桌面'} disabled={r.stale} onClick={()=>openDesktop(r)}><Monitor size={17}/></button><button className="icon-button" title="文件管理" aria-label={'管理 '+r.machine.name+' 文件'} onClick={()=>setFileRow(r)}><FolderOpen size={17}/></button><button className="icon-button" title="端口转发" aria-label={'查看 '+r.machine.name+' 端口转发'} onClick={()=>setPortRow(r)}><Network size={17}/></button><button className="icon-button" title="快照" aria-label={'查看 '+r.machine.name+' 快照'} onClick={()=>setSnapshotTarget({account:r.account,row:r})}><Archive size={17}/></button><button className={'icon-button keepalive-button'+(keepalive.policies.some(policy=>policy.machineId===r.machine.id&&policy.mode!=='off')?' enabled':'')} aria-label={'设置 '+r.machine.name+' 保活'} title="设置保活" onClick={()=>setKeepaliveRow(r)}><HeartPulse size={17}/></button><button className="icon-button" aria-label={'查看 '+r.machine.name+' 详情'} onClick={()=>setDetail(r)}><Ellipsis size={18}/></button></div></td>
        </tr>)}</tbody></table></div>}
        <footer className="panel-footer"><span><ShieldCheck size={14}/>状态查询不会唤醒机器，也不会重置空闲计时。</span><span>{refreshing?'正在同步…':errors.length?'部分账号未同步':'按账号独立同步'}</span></footer>
      </section>
      <div className="bottom-note"><Pause size={15}/><span>开启保活的机器会在时间窗口内自动恢复。终端操作会计入机器活动。</span></div>
      </>}
    </div><footer className="site-footer"><span>© {new Date().getFullYear()} <a href="https://github.com/meicuode/InstaBoxPanel" target="_blank" rel="noopener noreferrer">InstaBoxPanel</a></span><span aria-hidden="true">·</span><a href="https://cfnote.zuichu.de/blog?tag=InstaBox" target="_blank" rel="noopener noreferrer">使用指南</a></footer></main>
    {toast&&<div className={'toast '+(toast.error?'toast-error':'')} role={toast.error?'alert':'status'}>{toast.error?<CircleAlert size={18}/>:<Check size={18}/>}<span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setToast(null)}><X size={16}/></button></div>}
    {form&&<AccountForm current={form==='new'?null:form} close={()=>setForm(null)} saved={reloadAccounts}/>}
    {detail&&<Details row={latest(detail)} control={control(latest(detail))} close={()=>setDetail(null)} stop={()=>void change(latest(detail),'stop')} busy={submitting.has(detail.machine.id)||busyMap.has(detail.machine.id)} terminal={()=>{openTerminal(latest(detail));setDetail(null);}} desktop={()=>{openDesktop(latest(detail));setDetail(null);}} files={()=>{setFileRow(latest(detail));setDetail(null);}} ports={()=>{setPortRow(latest(detail));setDetail(null);}} snapshots={()=>{const row=latest(detail);setSnapshotTarget({account:row.account,row});setDetail(null);}}/>}
    {snapshotTarget&&<Suspense fallback={<div className="toast">正在加载快照…</div>}><SnapshotPane key={snapshotTarget.account.id+':'+(snapshotTarget.row?.machine.id||'all')} account={accounts.find(a=>a.id===snapshotTarget.account.id)||{...snapshotTarget.account,enabled:false}} row={snapshotTarget.row?latest(snapshotTarget.row):undefined} onClose={()=>setSnapshotTarget(null)}/></Suspense>}
    {fileRow&&<Suspense fallback={<div className="toast">正在加载文件管理…</div>}><FilePane key={fileRow.machine.id} row={latest(fileRow)} onClose={()=>setFileRow(null)} onAuthError={authError}/></Suspense>}
    {portRow&&<Suspense fallback={<div className="toast">正在加载端口转发…</div>}><PortPane key={portRow.machine.id} row={latest(portRow)} onClose={()=>setPortRow(null)} onAuthError={authError}/></Suspense>}
    {keepaliveRow&&<KeepaliveForm row={latest(keepaliveRow)} overview={keepalive} close={()=>setKeepaliveRow(null)} saved={value=>{setKeepalive(value);notify('保活设置已保存。');}}/>}
    {telegramOpen&&<TelegramForm close={()=>setTelegramOpen(false)}/>}
    {terminalWindows.windows.map(({row:terminal,minimized},index)=><Suspense key={terminal.machine.id} fallback={<div className="toast" role="status">正在加载终端…</div>}><TerminalPane row={latest(terminal)} control={control(latest(terminal))} index={index} active={activeSurface==='terminal'&&terminalWindows.activeId===terminal.machine.id} minimized={minimized} onActivate={()=>{setActiveSurface('terminal');terminalWindows.activate(terminal.machine.id);}} onMinimize={()=>terminalWindows.hide(terminal.machine.id,false)} onClose={()=>terminalWindows.hide(terminal.machine.id,true)}/></Suspense>)}
    <TerminalDock windows={terminalWindows.windows.filter(item=>item.minimized)} restore={id=>{setActiveSurface('terminal');terminalWindows.restore(id);}} close={terminalWindows.close}/>
    {desktopWindows.windows.map(({row,minimized},index)=><Suspense key={row.machine.id} fallback={<div className="toast">正在加载桌面…</div>}><DesktopPane row={latest(row)} index={index} active={activeSurface==='desktop'&&desktopWindows.activeId===row.machine.id} minimized={minimized} onActivate={()=>{setActiveSurface('desktop');desktopWindows.activate(row.machine.id);}} onMinimize={()=>desktopWindows.hide(row.machine.id,false)} onClose={()=>desktopWindows.close(row.machine.id)}/></Suspense>)}
    {!!desktopWindows.windows.some(item=>item.minimized)&&<aside className="desktop-dock" aria-label="收起的远程桌面">{desktopWindows.windows.filter(item=>item.minimized).map(({row})=><div key={row.machine.id}><button aria-label={'恢复 '+row.machine.name+' 远程桌面'} onClick={()=>{setActiveSurface('desktop');desktopWindows.restore(row.machine.id);}}><Monitor size={16}/>{row.machine.name}</button><button aria-label={'断开 '+row.machine.name+' 远程桌面'} onClick={()=>desktopWindows.close(row.machine.id)}><X size={15}/></button></div>)}</aside>}
    {history&&<Modal title="操作记录" onClose={()=>setHistory(false)} wide><p className="dialog-description">跟踪 Web、TG 和保活定时器的操作；刷新页面后仍可继续查看。</p>{!actions.length?<div className="empty"><Activity size={30}/><h3>还没有操作记录</h3></div>:<div className="history-list">{actions.map(a=><div className="history-row" key={a.id}><span className={'history-icon '+a.state}>{pending(a)?<LoaderCircle size={18} className="spin"/>:a.state==='succeeded'?<Check size={18}/>:<CircleAlert size={18}/>}</span><div className="history-body"><strong>{actionLabels[a.type]} · {a.machineName}</strong><small>{accounts.find(x=>x.id===a.accountId)?.label||'已移除账号'} · {new Date(a.createdAt).toLocaleString('zh-CN')}</small><p className="history-origin">操作备注：{actionSourceLabels[a.source||'unknown']}</p>{a.errorMessage&&<p className="history-error">{a.errorMessage}</p>}{a.type==='resume'&&a.processesPreserved===false&&<p className="history-error">机器已重新启动，原来的进程未保留。</p>}</div><div className="history-result"><span>{{submitting:'提交中',queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',unknown:'结果待确认'}[a.state]}</span>{a.state==='unknown'&&<button className="button compact" disabled={submitting.has(a.machineId)} onClick={()=>retry(a)}>重试原请求</button>}</div></div>)}</div>}</Modal>}
  </div>;
}
function Details({row,control,close,stop,busy,terminal,desktop,snapshots,ports,files}:{row:MachineRow;control:ReactNode;close:()=>void;stop:()=>void;busy:boolean;terminal:()=>void;desktop:()=>void;snapshots:()=>void;ports:()=>void;files:()=>void}){
  const [confirm,setConfirm]=useState(false);const m=row.machine;
  return <Modal title={m.name} onClose={close}><div className="detail-status"><span className={'state-badge '+(row.stale?'unknown':m.state)}><span/>{row.stale?'数据已过期':stateLabels[m.state]}</span><div className="row-actions">{control}<button className="button compact" disabled={row.stale} onClick={terminal}><TerminalSquare size={14}/>终端</button><button className="button compact" disabled={row.stale} onClick={desktop}><Monitor size={14}/>桌面</button><button className="button compact" onClick={files}><FolderOpen size={14}/>文件</button><button className="button compact" onClick={ports}><Network size={14}/>端口</button><button className="button compact" onClick={snapshots}><Archive size={14}/>快照</button></div></div>
    <dl className="details">{[['机器 ID',m.id],['可访问账号',row.sources.map(a=>a.label).join('、')],['组织 ID',m.orgId||'—'],['配置',m.spec.vcpus+' vCPU / '+m.spec.memMiB/1024+' GB'],['空闲自动暂停',m.autoSuspendAfterSeconds===null?'已关闭':m.autoSuspendAfterSeconds/60+' 分钟'],['服务就绪',m.runtime.ready?'已就绪':'尚未就绪'],['最近查询',row.checkedAt?new Date(row.checkedAt).toLocaleString('zh-CN'):'—']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {m.state==='running'&&<div className="stop-section"><h3><Square size={15}/>停止机器</h3><p>停止会结束当前进程，保留文件。下次启动会重新开机。</p>{confirm?<div className="stop-confirm"><span>确认结束这台机器上的所有进程？</span><button className="button danger" disabled={busy||row.stale} onClick={()=>{setConfirm(false);stop();}}>确认停止</button><button className="button subtle" onClick={()=>setConfirm(false)}>取消</button></div>:<button className="button" disabled={busy||row.stale} onClick={()=>setConfirm(true)}>停止机器…</button>}</div>}
  </Modal>;
}
