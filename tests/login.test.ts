import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createApp, type Env } from '../src/worker/app';
import { encryptKey, decryptKey } from '../src/worker/crypto';

const base='https://panel.test';
const writeHeaders={Origin:base,'Content-Type':'application/json','X-Panel-Request':'1'};
const credentials={username:'panel-owner',password:'test-owner-password-123'};

test('first-use login creates only panel tables, allows exactly one administrator, and protects encrypted data and sessions in workerd',async t=>{
  const bundle=await build({stdin:{contents:'import {createApp} from "./src/worker/app.ts"; export default createApp();',resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-19',d1Databases:['DB']}));
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    for(const sql of [
      'CREATE TABLE accounts (id TEXT PRIMARY KEY, payload TEXT)',
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO accounts VALUES ('other-app','keep this data')",
      "INSERT INTO d1_migrations VALUES (1,'other-app-init.sql')",
    ])await db.prepare(sql).run();
    const call=async(path:string,method='GET',body?:unknown,cookie='',headers:Record<string,string>={})=>{
      const response=await mf.dispatchFetch(base+path,{method,headers:{...writeHeaders,...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {response,status:response.status,body:await response.json() as any,cookie:response.headers.get('Set-Cookie')?.split(';')[0]||''};
    };
    let cookie='',username='';
    await t.test('login detects missing tables, initializes transactionally, and retries without manual SQL',async()=>{
      assert.equal((await call('/api/accounts')).status,401);
      const initial=await call('/api/auth/login','POST',credentials);assert.equal(initial.status,409);assert.equal(initial.body.error.code,'setup_required');
      const statuses=await Promise.all(Array.from({length:4},()=>call('/api/session')));
      assert.ok(statuses.every(result=>result.status===200&&result.body.setupRequired===true));
      assert.deepEqual((await db.prepare('SELECT name FROM insb_d1_migrations ORDER BY name').all()).results,[{name:'0001_initial.sql'},{name:'0002_auth.sql'},{name:'0003_keepalive.sql'},{name:'0004_telegram.sql'},{name:'0005_automation_keys.sql'},{name:'0006_action_sources.sql'},{name:'0007_telegram_buttons.sql'},{name:'0008_snapshot_requests.sql'},{name:'0009_box_panel.sql'}]);
      assert.deepEqual((await db.prepare('SELECT * FROM accounts').all()).results,[{id:'other-app',payload:'keep this data'}]);
      assert.deepEqual((await db.prepare('SELECT * FROM d1_migrations').all()).results,[{id:1,name:'other-app-init.sql'}]);
    });
    await t.test('setup validates origin and password length, and concurrent requests cannot replace the first administrator',async()=>{
      assert.equal((await call('/api/auth/setup','POST',credentials,'',{Origin:'https://evil.test'})).status,403);
      assert.equal((await call('/api/auth/setup','POST',{...credentials,password:'short'})).status,400);
      const results=await Promise.all([
        call('/api/auth/setup','POST',credentials),
        call('/api/auth/setup','POST',{...credentials,username:'second-owner'}),
      ]);
      assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);
      const created=results.find(result=>result.status===201)!;cookie=created.cookie;username=created.body.username;
      assert.equal(created.body.authenticated,true);
      const header=created.response.headers.get('Set-Cookie')!;
      for(const required of ['__Host-insb_session=','HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=43200'])assert.ok(header.includes(required));
      assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_admin').first<{total:number}>())!.total,1);
      assert.equal((await call('/api/auth/setup','POST',{...credentials,username:'replacement'})).status,409);
    });
    await t.test('database and API responses never expose plaintext passwords, data keys, or bearer sessions',async()=>{
      const stored=await db.prepare('SELECT * FROM insb_admin WHERE id=1').first<any>();
      assert.notEqual(stored.password_hash,credentials.password);assert.equal(stored.password_iterations,100000);
      const persisted=JSON.stringify((await db.prepare('SELECT * FROM insb_sessions').all()).results);
      assert.equal(persisted.includes(cookie.split('=')[1]),false);
      const status=await call('/api/session','GET',undefined,cookie);assert.equal(status.body.username,username);assert.equal(status.body.authenticated,true);
      assert.deepEqual(Object.keys(status.body).sort(),['authenticated','demo','setupRequired','username']);
      assert.equal((await call('/api/accounts','GET',undefined,cookie)).status,200);
      const timestamp=new Date().toISOString();
      await db.prepare("INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES ('saved-account','saved','remote-user','cipher','iv','abcd',?,?)").bind(timestamp,timestamp).run();
      await Promise.all(Array.from({length:3},()=>call('/api/session')));
      assert.equal((await db.prepare('SELECT key_ciphertext FROM insb_accounts WHERE id=?').bind('saved-account').first<any>())!.key_ciphertext,'cipher');
    });
    await t.test('wrong passwords and forged or expired sessions cannot access protected APIs',async()=>{
      const failed=await call('/api/auth/login','POST',{username,password:'wrong-password-123'});assert.equal(failed.status,401);assert.equal(failed.body.error.code,'invalid_credentials');assert.equal(failed.cookie,'');
      assert.equal((await call('/api/accounts','GET',undefined,'__Host-insb_session='+'A'.repeat(43))).status,401);
      const login=await call('/api/auth/login','POST',{username:username.toUpperCase(),password:credentials.password});assert.equal(login.status,200);
      assert.notEqual(login.cookie,cookie);cookie=login.cookie;
      await db.prepare('UPDATE insb_sessions SET expires_at=1').run();
      assert.equal((await call('/api/accounts','GET',undefined,cookie)).status,401);assert.equal((await call('/api/session','GET',undefined,cookie)).body.authenticated,false);
      cookie=(await call('/api/auth/login','POST',{username,password:credentials.password})).cookie;
      assert.ok(cookie);
    });
    await t.test('logout deletes the server session, and missing session tables are repaired without resetting the admin or accounts',async()=>{
      assert.equal((await call('/api/auth/logout','POST',{},cookie,{Origin:'https://evil.test'})).status,403);
      const logout=await call('/api/auth/logout','POST',{},cookie);assert.equal(logout.status,200);assert.ok(logout.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
      assert.equal((await call('/api/accounts','GET',undefined,cookie)).status,401);
      const hash=(await db.prepare('SELECT password_hash FROM insb_admin').first<any>())!.password_hash;
      await db.prepare('DROP TABLE insb_sessions').run();
      const status=await call('/api/session');assert.equal(status.status,200);assert.equal(status.body.setupRequired,false);
      assert.equal((await db.prepare('SELECT password_hash FROM insb_admin').first<any>())!.password_hash,hash);
      assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_accounts').first<any>())!.total,1);
      assert.equal((await call('/api/auth/login','POST',{username,password:credentials.password})).status,200);
    });
    await t.test('login throttling persists in D1 and HTTPS is required',async()=>{
      const expires=(Math.floor(Date.now()/900000)+1)*900000;
      await db.prepare('INSERT OR REPLACE INTO insb_login_limits (bucket,attempts,expires_at) VALUES (?,200,?)').bind('login:global:'+Math.floor(Date.now()/900000),expires).run();
      const throttled=await call('/api/auth/login','POST',{username,password:credentials.password});assert.equal(throttled.status,429);assert.ok(Number(throttled.response.headers.get('Retry-After'))>0);
      assert.equal((await mf.dispatchFetch('http://panel.test/api/session')).status,400);
    });
  }finally{await mf.dispose();}
});

test('missing D1 binding reports configuration error, and legacy keys must be preserved during first admin setup',async()=>{
  const app=createApp();
  const missing=await app.fetch(new Request(base+'/api/session'),{} as Env);assert.equal(missing.status,503);assert.equal((await missing.json() as any).error.code,'database_configuration');
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-19',d1Databases:['DB']}));
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const sql=await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
    for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    const key=Buffer.alloc(32,4).toString('base64'),encrypted=await encryptKey('ibk_preserved',key,'legacy');
    const timestamp=new Date().toISOString();
    await db.prepare("INSERT INTO insb_accounts (id,label,instabox_user_id,key_ciphertext,key_iv,key_suffix,created_at,updated_at) VALUES ('legacy','legacy','user',?,?, 'rved',?,?)").bind(encrypted.ciphertext,encrypted.iv,timestamp,timestamp).run();
    const request=()=>new Request(base+'/api/auth/setup',{method:'POST',headers:writeHeaders,body:JSON.stringify(credentials)});
    const env={DB:db} as Env;
    const rejected=await app.fetch(request(),env);assert.equal(rejected.status,503);assert.equal((await rejected.json() as any).error.code,'legacy_encryption_key_required');
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_admin').first<any>())!.total,0);
    const incorrect=await app.fetch(request(),{...env,KEY_ENCRYPTION_SECRET:Buffer.alloc(32,5).toString('base64')});assert.equal(incorrect.status,503);
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM insb_admin').first<any>())!.total,0);
    const accepted=await app.fetch(request(),{...env,KEY_ENCRYPTION_SECRET:key});assert.equal(accepted.status,201);
    const cookie=accepted.headers.get('Set-Cookie')!.split(';')[0];
    const {authenticateSession}=await import('../src/worker/session');
    const identity=await authenticateSession(new Request(base,{headers:{Cookie:cookie}}),db);
    assert.equal(identity.key,key);assert.equal(await decryptKey(encrypted.ciphertext,encrypted.iv,identity.key,'legacy'),'ibk_preserved');
    const withoutSecret=await app.fetch(new Request(base+'/api/accounts',{headers:{Cookie:cookie}}),env);assert.equal(withoutSecret.status,200);
  }finally{await mf.dispose();}
});
