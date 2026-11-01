import { useEffect, useId, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { Monitor, X, Maximize2, Minimize2, PanelBottomClose, RefreshCw, MousePointer2, Bot, ClipboardPaste, Copy, LoaderCircle } from 'lucide-react';
import { api, isDemo } from './api';
import type { DesktopCommand, DesktopState } from '../shared/resources';
import type { MachineRow } from './App';
import { useFloatingWindow } from './useFloatingWindow';

export default function DesktopPane({row,index,active,minimized,onActivate,onMinimize,onClose}:{row:MachineRow;index:number;active:boolean;minimized:boolean;onActivate:()=>void;onMinimize:()=>void;onClose:()=>void}) {
  const base='/api/accounts/'+row.account.id+'/machines/'+row.machine.id+'/desktop';
  const title=useId(),floating=useFloatingWindow(index),mount=useRef<HTMLDivElement>(null),rfb=useRef<RFB|null>(null);
  const [desktop,setDesktop]=useState<DesktopState|null>(null),[error,setError]=useState(''),[loadError,setLoadError]=useState('');
  const [remoteClipboard,setRemoteClipboard]=useState<string|null>(null),[clipboardNotice,setClipboardNotice]=useState('');
  const [connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[fresh,setFresh]=useState(false),[showActions,setShowActions]=useState(false);
  const [inputGranted,setInputGranted]=useState(false),mounted=useRef(true),commandEpoch=useRef(0);
  const [refresh,setRefresh]=useState(0),watchHealthy=useRef(false),lastStatus=useRef(0),owned=useRef(false),canInput=useRef(false);
  const enabled=row.account.enabled&&row.machine.state==='running';
  const controlling=inputGranted&&connected&&fresh&&!row.stale&&!minimized&&desktop?.agentPausable&&!desktop.controlError&&desktop.controller==='human'&&desktop.yours;
  canInput.current=!!controlling;
  const apply=(state:DesktopState)=>{setDesktop(state);lastStatus.current=Date.now();setFresh(true);setLoadError('');if(state.controller!=='human'||!state.yours){setInputGranted(false);setRemoteClipboard(null);setClipboardNotice('');}};
  function release() {
    commandEpoch.current++;
    setInputGranted(false);setRemoteClipboard(null);setClipboardNotice('');if(!owned.current)return;owned.current=false;if(rfb.current)rfb.current.viewOnly=true;
    if(isDemo)void api(base,{method:'POST',body:{action:'handback'}}).catch(()=>{});
    else void fetch(base,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Panel-Request':'1'},body:'{"action":"handback"}',keepalive:true}).catch(()=>{});
  }
  useEffect(()=>{
    if(!enabled){setDesktop(null);setFresh(false);return;}
    const controller=new AbortController();let timer:number,disposed=false;
    const poll=async()=>{
      try{if(!watchHealthy.current||isDemo)apply(await api<DesktopState>(base,{signal:controller.signal}));}
      catch(e){if(!disposed){setLoadError(e instanceof Error?e.message:'桌面状态读取失败。');setFresh(false);}}
      if(!disposed)timer=window.setTimeout(poll,desktop?.installing?2000:5000);
    };
    void poll();const clock=window.setInterval(()=>{if(Date.now()-lastStatus.current>12000){setFresh(false);if(rfb.current)rfb.current.viewOnly=true;watchHealthy.current=false;}},1000);
    return()=>{disposed=true;controller.abort();clearTimeout(timer);clearInterval(clock);};
  },[base,enabled,refresh,desktop?.installing]);
  useEffect(()=>{
    if(!enabled||!desktop?.running||!mount.current)return;
    let disposed=false,client:RFB|undefined,events:EventSource|undefined;const controller=new AbortController();
    setError('');setConnected(false);setRemoteClipboard(null);setClipboardNotice('');watchHealthy.current=false;
    if(isDemo){setConnected(true);return()=>setConnected(false);}
    void (async()=>{
      const result=await api<{connection:string}>(base+'/connection',{method:'POST',body:{},signal:controller.signal});
      if(disposed)return;
      const url=new URL(base+'/vnc',location.origin);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('connection',result.connection);
      client=new RFB(mount.current!,url.href,{shared:true});rfb.current=client;client.viewOnly=true;client.scaleViewport=true;client.resizeSession=false;client.showDotCursor=true;
      client.addEventListener('connect',()=>{
        if(disposed)return;setConnected(true);
        const watch=new URL(base+'/watch',location.origin);watch.searchParams.set('connection',result.connection);events=new EventSource(watch);
        events.addEventListener('status',event=>{try{apply(JSON.parse((event as MessageEvent).data));watchHealthy.current=true;}catch{setFresh(false);watchHealthy.current=false;}});
        events.addEventListener('stale',()=>{setFresh(false);watchHealthy.current=false;if(client)client.viewOnly=true;});
        events.addEventListener('end',()=>{watchHealthy.current=false;setFresh(false);events?.close();});
        events.onerror=()=>{watchHealthy.current=false;setFresh(false);if(client)client.viewOnly=true;events?.close();};
      });
      client.addEventListener('disconnect',()=>{if(!disposed){setConnected(false);setFresh(false);setRemoteClipboard(null);setClipboardNotice('');setError('桌面连接已断开，请重新连接。');}events?.close();watchHealthy.current=false;});
      client.addEventListener('clipboard',event=>{
        if(disposed)return;
        const text=(event as CustomEvent<{text:string}>).detail?.text;
        if(typeof text==='string'){
          setRemoteClipboard(text);setClipboardNotice('已收到虚拟机剪贴板内容。');
        }
      });
      client.addEventListener('securityfailure',()=>{if(!disposed)setError('桌面连接被平台拒绝，请重新连接或检查账号权限。');});
      client.addEventListener('credentialsrequired',()=>{if(!disposed)setError('平台桌面要求额外凭据，请到官方控制台检查。');client?.disconnect();});
    })().catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'桌面连接失败。');});
    return()=>{disposed=true;controller.abort();events?.close();client?.disconnect();rfb.current=null;watchHealthy.current=false;setConnected(false);};
  },[base,enabled,desktop?.running,attempt]);
  useEffect(()=>{if(rfb.current){rfb.current.viewOnly=!controlling;rfb.current.focusOnClick=!!controlling&&active;}},[controlling,active]);
  useEffect(()=>{if(minimized){release();setRefresh(value=>value+1);}},[minimized]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;release();};},[base]);
  async function command(action:DesktopCommand) {
    const epoch=++commandEpoch.current;
    setBusy(true);setError('');if(action==='handback'){setInputGranted(false);setRemoteClipboard(null);setClipboardNotice('');if(rfb.current)rfb.current.viewOnly=true;}
    try{const state=await api<DesktopState>(base,{method:'POST',body:{action}});
      if(action==='takeover')owned.current=state.controller==='human'&&state.yours;
      if(!mounted.current||commandEpoch.current!==epoch){if(action==='takeover')release();return;}
      apply(state);if(action==='takeover')setInputGranted(state.controller==='human'&&state.yours);if(action==='handback')owned.current=false;
      if(action==='start')setAttempt(value=>value+1);setRefresh(value=>value+1);}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'桌面操作失败。');}finally{if(mounted.current)setBusy(false);}
  }
  async function paste() {try{const text=await navigator.clipboard.readText();if(canInput.current)rfb.current?.clipboardPasteFrom(text);}catch{setError('无法读取剪贴板，请检查浏览器权限。');}}
  async function copyRemoteClipboard() {
    if(!canInput.current||remoteClipboard===null)return;
    try{await navigator.clipboard.writeText(remoteClipboard);setClipboardNotice('虚拟机剪贴板已复制到本机。');setError('');}
    catch{setClipboardNotice('无法写入本机剪贴板，请检查浏览器权限。');}
  }
  return <section hidden={minimized} role="dialog" aria-modal="false" aria-labelledby={title} className={'desktop-dialog'+(active?' active':'')+(floating.maximized?' maximized':'')} style={{...floating.style,zIndex:active?210:105+index}} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="desktop-heading" {...floating.drag} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button'))floating.toggleMaximized();}}>
      <div><Monitor size={18}/><h2 id={title}>{row.machine.name} · 远程桌面</h2><small>{isDemo?'演示':row.account.label}</small></div>
      <div><button className="icon-button" aria-label="最小化远程桌面" onClick={()=>{release();onMinimize();}}><PanelBottomClose size={17}/></button><button className="icon-button" aria-label={floating.maximized?'还原远程桌面':'最大化远程桌面'} onClick={floating.toggleMaximized}>{floating.maximized?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button><button className="icon-button" aria-label="关闭远程桌面" onClick={()=>{release();onClose();}}><X size={19}/></button></div>
    </header>
    <div className="desktop-toolbar"><span className={'desktop-controller '+(controlling?'human':'')}><span className={'connection-dot '+(connected?'good':'bad')}/>{!connected?'未连接':!fresh?'状态待确认 · 只读':controlling?'你正在控制':desktop?.controller==='human'?'其他窗口正在控制':'AI 控制 · 当前只读'}</span>
      <div>{controlling?<button className="button compact" disabled={busy} onClick={()=>void command('handback')}><Bot size={14}/>交还 AI</button>:<button className="button compact" disabled={busy||!connected||!fresh||row.stale||!desktop?.agentPausable||!!desktop.controlError} onClick={()=>void command('takeover')}><MousePointer2 size={14}/>人工接管</button>}
      <button className="button compact" disabled={!controlling||isDemo} onClick={()=>void paste()} title="发送到远端剪贴板后，在远端应用中粘贴"><ClipboardPaste size={14}/>发送剪贴板</button>
      <button className="button compact" disabled={!controlling||remoteClipboard===null||isDemo} onClick={()=>void copyRemoteClipboard()} title="先在虚拟机中复制文本，再点击将它复制到本机"><Copy size={14}/>复制到本机</button>
      <button className="button compact" onClick={()=>setShowActions(value=>!value)} aria-expanded={showActions}>操作记录</button></div>
    </div>
    {clipboardNotice&&<div className="notice success desktop-notice" role="status">{clipboardNotice}</div>}
    {(error||loadError||desktop?.controlError)&&<div className="notice error desktop-notice" role="alert">{error||loadError||desktop?.controlError}</div>}
    <div className="desktop-body">
      {!enabled?<div className="desktop-empty"><Monitor size={36}/><p>请先启用账号，并恢复或启动机器。</p></div>:!desktop?<div className="desktop-empty"><LoaderCircle className="spin"/><p>正在读取桌面状态…</p></div>:!desktop.running?<div className="desktop-empty"><Monitor size={36}/><h3>{desktop.installing?'正在安装桌面':desktop.failed?'桌面安装未完成':desktop.installed?'桌面尚未启动':'此机器尚未安装桌面'}</h3><p>{desktop.installing?'平台正在准备图形环境，状态会自动更新。':desktop.installed?'启动后可以观看，并按需要接管鼠标键盘。':'首次安装约占用 1.4 GiB 系统盘空间，由平台完成安装。'}</p><button className="button primary" disabled={busy||desktop.installing} onClick={()=>void command(desktop.installed?'start':'install')}>{busy&&<LoaderCircle size={15} className="spin"/>}{desktop.installed?'启动桌面':'安装桌面'}</button></div>:<div className="desktop-screen" ref={mount}>{isDemo&&<div className="demo-desktop"><div className="demo-desktop-bar">应用程序　文件管理器　终端</div><div className="demo-desktop-window"><strong>演示桌面 · 文本编辑器</strong><p>此处模拟桌面与控制权，不连接真实机器。</p><textarea aria-label="演示桌面输入" placeholder="点击“人工接管”后可以输入…" disabled={!controlling}/></div></div>}</div>}
      {showActions&&<aside className="desktop-actions"><h3>最近 AI 操作</h3>{!desktop?.actions.length?<p>尚无操作记录。</p>:desktop.actions.slice().reverse().map((action,i)=><div key={action.time+i}><strong>{action.tool}</strong><small>{action.time?new Date(action.time).toLocaleTimeString('zh-CN'):''}{action.refused?' · 已拒绝输入':''}</small></div>)}</aside>}
    </div>
    <footer className="desktop-footer"><span>{desktop&&!desktop.agentPausable?'此机器不支持暂停 AI 输入，仅可观看。':'接管后 AI 输入暂停；最小化或关闭时交还控制。'}</span><button className="button compact" disabled={!enabled||busy} onClick={()=>{setError('');setRefresh(value=>value+1);setAttempt(value=>value+1);}}><RefreshCw size={14}/>重新连接桌面</button></footer>
    {!floating.maximized&&(['nw','ne','sw','se'] as const).map(corner=><div key={corner} className={'terminal-resize terminal-resize-'+corner} aria-label={'调整远程桌面 '+corner} {...floating.resize(corner)}/>)}
  </section>;
}
