import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

export async function checkResourceViews(page,output) {
  await page.getByRole('button',{name:'打开 development 远程桌面',exact:true}).click();
  const desktop=page.getByRole('dialog',{name:'development · 远程桌面',exact:true});
  const input=desktop.getByRole('textbox',{name:'演示桌面输入'});await input.waitFor();assert.equal(await input.isDisabled(),true);
  await desktop.getByRole('button',{name:'人工接管',exact:true}).click();await input.fill('远程桌面中文输入验证');
  await desktop.getByRole('button',{name:'操作记录',exact:true}).click();await desktop.getByText('click',{exact:true}).waitFor();
  await desktop.getByRole('button',{name:'交还 AI',exact:true}).click();assert.equal(await input.isDisabled(),true);
  await desktop.getByRole('button',{name:'人工接管',exact:true}).click();
  await desktop.getByRole('button',{name:'最小化远程桌面',exact:true}).click();await desktop.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'恢复 development 远程桌面',exact:true}).click();assert.equal(await input.isDisabled(),true);
  await desktop.getByRole('button',{name:'最大化远程桌面',exact:true}).click();assert.ok((await desktop.boundingBox()).width>=page.viewportSize().width-2);
  await desktop.getByRole('button',{name:'还原远程桌面',exact:true}).click();await page.screenshot({path:path.join(output,'desktop-controls.png')});
  await desktop.getByRole('button',{name:'关闭远程桌面',exact:true}).click();await desktop.waitFor({state:'detached'});

  await page.getByRole('button',{name:'查看 development 快照',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'development · 快照',exact:true});await modal.getByText('initial-backup',{exact:true}).waitFor();
  await modal.getByRole('button',{name:'新增快照',exact:true}).click();await modal.getByLabel('快照名称',{exact:true}).fill('browser-snapshot');
  await modal.getByLabel('快照说明',{exact:true}).fill('浏览器验证');await modal.getByLabel('仅保存系统文件，不包含 /data',{exact:true}).check();
  await modal.getByRole('button',{name:'创建快照',exact:true}).click();const card=modal.locator('.snapshot-card').filter({hasText:'browser-snapshot'});await card.waitFor();await card.getByText('可用',{exact:true}).waitFor();await card.getByText('仅系统文件',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'snapshot-list.png')});
  await card.getByRole('button',{name:'删除快照 browser-snapshot',exact:true}).click();
  const confirm=modal.getByRole('button',{name:'确认删除快照',exact:true});assert.equal(await confirm.isDisabled(),true);
  await modal.getByLabel('确认快照名称',{exact:true}).fill('wrong');assert.equal(await confirm.isDisabled(),true);
  await modal.getByLabel('确认快照名称',{exact:true}).fill('browser-snapshot');await confirm.click();await card.waitFor({state:'detached'});
  await modal.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'查看 browser-agent 快照',exact:true}).click();
  const paused=page.getByRole('dialog',{name:'browser-agent · 快照',exact:true});assert.equal(await paused.getByRole('button',{name:'新增快照',exact:true}).isDisabled(),true);await paused.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'主账号 · 账号快照',exact:true}).click();await page.getByRole('dialog',{name:'主账号 · 快照',exact:true}).getByText('initial-backup',{exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  const viewport=page.viewportSize();await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开 development 远程桌面',exact:true}).click();await desktop.getByRole('textbox',{name:'演示桌面输入'}).waitFor();assert.ok((await desktop.boundingBox()).width<=390);await page.screenshot({path:path.join(output,'desktop-mobile.png')});await desktop.getByRole('button',{name:'关闭远程桌面',exact:true}).click();await page.setViewportSize(viewport);
}

export async function checkDesktopProtocol(browser,root,output) {
  const base='http://127.0.0.1:4181',child=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--mode','test','--host','127.0.0.1','--port','4181'],{cwd:root,env:{...process.env,VITE_DEMO:'false'},windowsHide:true,stdio:'ignore'});
  const context=await browser.newContext({viewport:{width:1280,height:900}});let page;
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  try{
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    // Keep the browser's native WebSocket. Playwright's routed socket inherits
    // methods one prototype too deep for noVNC's raw-channel validation.
    await context.addInitScript(port=>{
      const NativeWebSocket=window.WebSocket;
      window.WebSocket=class extends NativeWebSocket {
        constructor(url,protocols){
          const target=new URL(url,location.href);
          if(target.pathname.endsWith('/desktop/vnc')){target.protocol='ws:';target.host='127.0.0.1:'+port;}
          return new NativeWebSocket(target.href,protocols);
        }
      };
    },server.address().port);
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,150));}assert.ok(ready);
    page=await context.newPage();const inputEvents=[],resizeRequests=[],errors=[];let failStatus=false,active=0,resizeMode='accept';
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',message=>{if(message.type()==='error')console.log('VNC_BROWSER',message.text());});
    const desktop={installed:true,installing:false,running:true,failed:false,agentPausable:true,controller:'agent',yours:false,controlError:'',actions:[]};
    const account={id:'vnc-account',label:'VNC 账号',enabled:true},machine={id:'vnc-machine',name:'vnc-test',state:'running',operationId:null,spec:{vcpus:4,memMiB:8192},runtime:{ready:true}};
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url()),method=route.request().method();
      if(url.pathname.endsWith('/desktop/watch'))return route.fulfill({status:404,json:{error:{message:'watch unavailable'}}});
      if(url.pathname.endsWith('/desktop')){
        if(method==='POST'){const body=route.request().postDataJSON();desktop.controller=body.action==='takeover'?'human':'agent';desktop.yours=body.action==='takeover';}
        else if(failStatus)return route.fulfill({status:503,json:{error:{code:'unavailable',message:'平台暂时离线'}}});
        return route.fulfill({json:desktop});
      }
      const result=url.pathname==='/api/session'?{authenticated:true,username:'vnc-admin'}:url.pathname==='/api/accounts'?{accounts:[account]}:url.pathname==='/api/actions'?{actions:[]}:url.pathname==='/api/keepalive'?{policies:[],intervalMinutes:1,maxMachines:5,lastRunAt:null}:url.pathname.endsWith('/machines')?{machines:[machine],checkedAt:new Date(Date.now()+120000).toISOString()}:url.pathname.endsWith('/desktop/connection')?{connection:'test-sealed-handle'}:{};
      await route.fulfill({json:result});
    });
    server.on('connection',socket=>{
      active++;socket.on('close',()=>active--);let stage=0,pending=Buffer.alloc(0),painted=false,extendedDesktopSize=false,frameWidth=80,frameHeight=50;
      let format={bigEndian:false,redShift:16,greenShift:8,blueShift:0};
      const sendDesktopSize=(width,height,reason=0,status=0)=>{const update=Buffer.alloc(36);update[0]=0;update.writeUInt16BE(1,2);update.writeUInt16BE(reason,4);update.writeUInt16BE(status,6);update.writeUInt16BE(width,8);update.writeUInt16BE(height,10);update.writeInt32BE(-308,12);update[16]=1;update.writeUInt32BE(1,20);update.writeUInt16BE(width,28);update.writeUInt16BE(height,30);socket.send(update);};
      socket.send(Buffer.from('RFB 003.008\n'));
      socket.on('message',message=>{
        pending=Buffer.concat([pending,Buffer.from(message)]);
        while(pending.length){
          let length;
          if(stage===0)length=12;else if(stage<3)length=1;else{const type=pending[0];if(type===0)length=20;else if(type===2){if(pending.length<4)return;length=4+pending.readUInt16BE(2)*4;}else if(type===3)length=10;else if(type===4)length=8;else if(type===5)length=6;else if(type===6){if(pending.length<8)return;length=8+pending.readUInt32BE(4);}else if(type===251)length=24;else throw new Error('Unexpected RFB client message '+type);}
          if(pending.length<length)return;const frame=pending.subarray(0,length);pending=pending.subarray(length);
          if(stage===0){stage=1;socket.send(Buffer.from([1,1]));}
          else if(stage===1){stage=2;socket.send(Buffer.alloc(4));}
          else if(stage===2){stage=3;const name=Buffer.from('Test desktop'),init=Buffer.alloc(24+name.length);init.writeUInt16BE(80,0);init.writeUInt16BE(50,2);Buffer.from([32,24,0,1,0,255,0,255,0,255,16,8,0,0,0,0]).copy(init,4);init.writeUInt32BE(name.length,20);name.copy(init,24);socket.send(init);}
          else if(frame[0]===0){assert.equal(frame[4],32);format={bigEndian:!!frame[6],redShift:frame[14],greenShift:frame[15],blueShift:frame[16]};}
          else if(frame[0]===2){for(let index=0;index<frame.readUInt16BE(2);index++)if(frame.readInt32BE(4+index*4)===-308)extendedDesktopSize=true;if(extendedDesktopSize)sendDesktopSize(frameWidth,frameHeight);}
          else if(frame[0]===3&&!painted){painted=true;const update=Buffer.alloc(16+80*50*4);update.writeUInt16BE(1,2);update.writeUInt16BE(80,8);update.writeUInt16BE(50,10);const color=(48<<format.redShift)|(144<<format.greenShift)|(96<<format.blueShift);for(let p=16;p<update.length;p+=4){if(format.bigEndian)update.writeUInt32BE(color>>>0,p);else update.writeUInt32LE(color>>>0,p);}socket.send(update);}
          else if(frame[0]===251){assert.ok(extendedDesktopSize,'client requested resize before ExtendedDesktopSize negotiation');const width=frame.readUInt16BE(2),height=frame.readUInt16BE(4);resizeRequests.push([width,height]);if(resizeMode==='ignore')continue;if(resizeMode==='reject'){sendDesktopSize(frameWidth,frameHeight,1,1);continue;}frameWidth=width;frameHeight=height;sendDesktopSize(width,height,1);}
          else if(frame[0]===4||frame[0]===5||frame[0]===6){inputEvents.push(Buffer.from(frame));if(frame[0]===6){const text=frame.subarray(8).toString('latin1');assert.equal(text,'host to VM');page.evaluate(()=>window.__rfbClipboardSent=true).catch(()=>{});}}
        }
      });
    });
    await page.goto(base);await page.getByRole('button',{name:'打开 vnc-test 远程桌面',exact:true}).click();
    const pane=page.getByRole('dialog',{name:'vnc-test · 远程桌面',exact:true}),canvas=pane.locator('canvas');await canvas.waitFor();
    await page.waitForFunction(()=>{const canvas=document.querySelector('.desktop-screen canvas');return canvas?.width===80&&canvas.height===50&&canvas.getContext('2d').getImageData(0,0,1,1).data[0]===48;});
    assert.deepEqual(await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,1,1).data)),[48,144,96,255],'RFB framebuffer pixels');
    const resolution=pane.getByRole('combobox',{name:'远程桌面分辨率'});assert.equal(await resolution.isDisabled(),true);
    await canvas.click();await page.keyboard.press('x');assert.equal(inputEvents.length,0);
    await pane.getByRole('button',{name:'人工接管',exact:true}).click();await pane.getByText('你正在控制',{exact:true}).waitFor();assert.equal(await resolution.isEnabled(),true);await canvas.click();await page.keyboard.press('x');await page.waitForTimeout(150);assert.ok(inputEvents.some(f=>f[0]===4),'RFB key input after takeover');
    await resolution.selectOption('1280x720');await page.waitForFunction(()=>{const canvas=document.querySelector('.desktop-screen canvas');return canvas?.width===1280&&canvas.height===720;});assert.ok(resizeRequests.some(([width,height])=>width===1280&&height===720),'RFB SetDesktopSize requested 1280x720');
    await page.waitForFunction(()=>!document.querySelector('[aria-label="远程桌面分辨率"]').disabled);
    const checkPointer=async()=>{
      const before=inputEvents.length;
      await canvas.click();
      for(let retry=0;retry<40&&!inputEvents.slice(before).some(frame=>frame[0]===5&&frame[1]===1);retry++)await page.waitForTimeout(25);
      const pointer=inputEvents.slice(before).findLast(frame=>frame[0]===5&&frame[1]===1);
      assert.ok(pointer,'remote desktop received pointer press');
      assert.ok(Math.abs(pointer.readUInt16BE(2)-640)<=2&&Math.abs(pointer.readUInt16BE(4)-360)<=2,`scaled center click must reach 640,360, received ${pointer.readUInt16BE(2)},${pointer.readUInt16BE(4)}`);
      const bounds=await canvas.boundingBox(),viewport=await pane.locator('.desktop-viewport').boundingBox();
      assert.ok(bounds.width<=viewport.width+1&&bounds.height<=viewport.height+1,'the full remote screen fits its viewport');
    };
    await checkPointer();
    const resizeCount=resizeRequests.length;
    await pane.getByRole('button',{name:'最大化远程桌面',exact:true}).click();await checkPointer();
    await pane.getByRole('button',{name:'还原远程桌面',exact:true}).click();
    await page.setViewportSize({width:390,height:844});await checkPointer();
    await page.screenshot({path:path.join(output,'desktop-resolution-mobile.png')});
    await page.setViewportSize({width:1280,height:900});await checkPointer();
    assert.equal(resizeRequests.length,resizeCount,'window resizing only scales the selected remote resolution');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>'host to VM',writeText:async text=>{window.__systemClipboard=text;}}}));
    await pane.getByRole('button',{name:'发送剪贴板',exact:true}).click();await page.waitForFunction(()=>window.__systemClipboard===undefined);
    await page.waitForFunction(()=>window.__rfbClipboardSent===true);
    const remoteText=Buffer.from('VM to host');const cutText=Buffer.alloc(8+remoteText.length);cutText[0]=3;cutText.writeUInt32BE(remoteText.length,4);remoteText.copy(cutText,8);server.clients.forEach(socket=>{if(socket.readyState===1)socket.send(cutText);});
    const clipboardStatus=pane.locator('.desktop-controller').getByRole('status');await clipboardStatus.getByText('已收到虚拟机剪贴板内容。',{exact:true}).waitFor();
    assert.ok((await pane.locator('.desktop-controller').boundingBox()).height<30,'clipboard notice shares the control status line');
    const selectBounds=await resolution.boundingBox(),handbackBounds=await pane.getByRole('button',{name:'交还 AI',exact:true}).boundingBox();
    assert.ok(selectBounds.x+selectBounds.width<=handbackBounds.x&&Math.abs(selectBounds.y-handbackBounds.y)<5,'resolution selector is directly left of handback');
    await page.screenshot({path:path.join(output,'desktop-resolution.png')});
    const copyRemote=pane.getByRole('button',{name:'复制到本机',exact:true});await copyRemote.waitFor();assert.equal(await copyRemote.isEnabled(),true);
    await copyRemote.click();await page.waitForFunction(()=>window.__systemClipboard==='VM to host');assert.equal(await pane.getByText('虚拟机剪贴板已复制到本机。',{exact:true}).count(),1);
    await resolution.selectOption('fit');assert.equal(await pane.getByRole('alert').count(),0);await checkPointer();
    assert.equal(resizeRequests.length,resizeCount,'fit keeps the current server resolution');
    resizeMode='reject';await resolution.selectOption('1920x1080');
    await pane.getByRole('alert').filter({hasText:'VNC 服务端未接受分辨率调整'}).waitFor();
    assert.equal(await resolution.inputValue(),'fit');await checkPointer();
    const rejectedCount=resizeRequests.length;
    await resolution.selectOption('1280x720');assert.equal(await pane.getByRole('alert').count(),0);
    assert.equal(resizeRequests.length,rejectedCount,'reselecting the current resolution clears the error without another request');
    resizeMode='ignore';await resolution.selectOption('1600x900');
    await pane.getByRole('status').filter({hasText:'正在调整分辨率'}).waitFor();
    await pane.getByRole('button',{name:'交还 AI',exact:true}).click();const before=inputEvents.length;await canvas.click();await page.keyboard.press('y');await page.waitForTimeout(100);assert.equal(inputEvents.length,before,'handback blocks all VNC input');
    assert.equal(await resolution.inputValue(),'fit');assert.equal(await pane.getByText('正在调整分辨率…',{exact:true}).count(),0,'handback cancels a pending resize');
    assert.equal(await copyRemote.isDisabled(),true,'remote clipboard copy is disabled after handback');assert.equal(await pane.getByText('已收到虚拟机剪贴板内容。',{exact:true}).count(),0,'handback clears staged remote clipboard text');
    resizeMode='accept';await pane.getByRole('button',{name:'重新连接桌面',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.desktop-screen canvas')?.width===80);
    await pane.getByRole('button',{name:'人工接管',exact:true}).click();await pane.getByText('你正在控制',{exact:true}).waitFor();
    resizeMode='ignore';await resolution.selectOption('1920x1080');
    await pane.getByRole('status').filter({hasText:'正在调整分辨率'}).waitFor();
    await pane.getByRole('button',{name:'重新连接桌面',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.desktop-screen canvas')?.width===80);
    await page.waitForFunction(()=>!document.querySelector('[aria-label="远程桌面分辨率"]').disabled);
    assert.equal(await resolution.inputValue(),'fit');
    resizeMode='accept';await resolution.selectOption('1280x720');
    await page.waitForFunction(()=>document.querySelector('.desktop-screen canvas')?.width===1280&&!document.querySelector('[aria-label="远程桌面分辨率"]').disabled);
    await checkPointer();assert.equal(await pane.getByRole('alert').count(),0,'reconnect clears the old resize and permits a new one');
    await pane.getByRole('button',{name:'交还 AI',exact:true}).click();
    await pane.getByRole('button',{name:'人工接管',exact:true}).click();await pane.getByText('你正在控制',{exact:true}).waitFor();failStatus=true;await pane.getByText('平台暂时离线',{exact:true}).waitFor();const staleCount=inputEvents.length;await canvas.click();await page.keyboard.press('z');await page.waitForTimeout(100);assert.equal(inputEvents.length,staleCount,'stale status blocks input');
    await page.screenshot({path:path.join(output,'desktop-rfb-protocol.png')});await pane.getByRole('button',{name:'关闭远程桌面',exact:true}).click();await page.waitForTimeout(200);assert.equal(active,0);assert.equal(desktop.controller,'agent');
    await checkSnapshotFailureRecovery(page);assert.deepEqual(errors,[]);
  }catch(error){if(page){await page.screenshot({path:path.join(output,'desktop-protocol-failure.png')}).catch(()=>{});console.log('VNC_PAGE',await page.locator('body').innerText().catch(()=>''));}throw error;}
  finally{await context.close();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));child.kill();}
}

async function checkSnapshotFailureRecovery(page) {
  const submissions=[];let lists=0;
  await page.route('**/api/accounts/vnc-account/**/snapshots',async route=>{
    const body=route.request().postDataJSON();submissions.push(body);
    if(submissions.length===1)return route.fulfill({status:202,json:{request:{state:'failed',error:'快照配额已用完'}}});
    if(submissions.length===2)return route.fulfill({status:422,json:{error:{code:'snapshot_scope',message:'创建快照权限不足'}}});
    if(submissions.length===3)return route.abort('failed');
    return route.fulfill({status:202,json:{request:{state:'pending'}}});
  });
  await page.route('**/api/accounts/vnc-account/snapshots',route=>{lists++;return route.fulfill({json:{snapshots:[],requests:[]}});});
  await page.getByRole('button',{name:'查看 vnc-test 快照',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'vnc-test · 快照',exact:true});
  await modal.getByText('暂无快照',{exact:true}).waitFor();await modal.getByRole('button',{name:'新增快照',exact:true}).click();
  const name=modal.getByLabel('快照名称',{exact:true});await name.fill('failed-snapshot');
  await modal.getByRole('button',{name:'创建快照',exact:true}).click();await modal.getByText('快照配额已用完',{exact:true}).waitFor();
  assert.equal(await name.isDisabled(),false);await name.fill('corrected-snapshot');
  const refreshed=page.waitForResponse(r=>r.url().endsWith('/snapshots')&&r.request().method()==='GET');
  await modal.getByRole('button',{name:'刷新快照',exact:true}).click();await refreshed;
  assert.equal(await modal.getByText('快照配额已用完',{exact:true}).isVisible(),true,'refresh preserves submission error');
  await modal.getByRole('button',{name:'创建快照',exact:true}).click();await modal.getByText('创建快照权限不足',{exact:true}).waitFor();
  assert.equal(await name.isDisabled(),false);assert.notEqual(submissions[1].requestId,submissions[0].requestId);
  await name.fill('uncertain-snapshot');await modal.getByRole('button',{name:'创建快照',exact:true}).click();
  await modal.getByRole('button',{name:'重试本次提交',exact:true}).waitFor();assert.equal(await name.isDisabled(),true);
  await modal.getByRole('button',{name:'重试本次提交',exact:true}).click();await name.waitFor({state:'detached'});
  assert.equal(submissions[3].requestId,submissions[2].requestId,'network retry preserves the original request');
  assert.ok(lists>=2);await modal.getByRole('button',{name:'关闭',exact:true}).click();
}
