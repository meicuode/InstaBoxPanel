import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, stat, readdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { uploadScript } from '../src/worker/upload-script.ts';

const output = path.resolve('test-results'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'upload-assembly-'));
const linuxPath = value => process.platform === 'win32' ? '/mnt/' + value[0].toLowerCase() + value.slice(2).replaceAll('\\', '/') : value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let checks = 0;
async function run(action, session, extra = {}, success = true) {
  assert.ok(path.resolve(session.target).startsWith(root + path.sep), 'All test operations stay in the generated workspace directory.');
  const args = [action, linuxPath(session.target), session.id, session.guard, String(session.size), String(session.chunk), String(extra.index || 0), extra.nonce || '', extra.hash || '', String(extra.overwrite === true), String(extra.parents === true)];
  const binary = process.platform === 'win32' ? 'wsl.exe' : 'bash';
  const prefix = process.platform === 'win32' ? ['-d', 'Ubuntu', '--exec', 'bash'] : [];
  const child = spawn(binary, [...prefix, '-s', '--', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); child.stdin.end(uploadScript); });
  if (success) assert.equal(code, 0, action + ': ' + stdout + '\n' + stderr);
  else assert.notEqual(code, 0, action + ' must fail');
  return stdout;
}
function session(name, size, chunk = 16 * 1024 * 1024) {
  const id = randomUUID(); return { id, guard: hash(Buffer.from(id)), target: path.join(root, name), size, chunk, get directory() { return path.join(path.dirname(this.target), '.instabox-upload-' + id); } };
}
async function part(s, index, bytes, badHash = false) {
  const nonce = randomUUID(), digest = badHash ? 'f'.repeat(64) : hash(bytes);
  await run('prepare', s, { index, nonce, hash: digest });
  await writeFile(path.join(s.directory, 'incoming-' + nonce), bytes);
  return run('accept', s, { index, nonce, hash: digest }, !badHash);
}
async function wait(s, desired = 'complete') {
  for (let i = 0; i < 100; i++) {
    const state = (await readFile(path.join(s.directory, 'state'), 'utf8')).trim();
    if (state !== 'merging') { assert.equal(state, desired, await readFile(path.join(s.directory, 'error'), 'utf8').catch(() => '')); return; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Assembly did not finish');
}
async function fileHash(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
try {
  const chunk = Buffer.alloc(16 * 1024 * 1024); for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
  const tail = Buffer.from('尾片\0\xff'), large = session('large 中文 & literal.bin', chunk.length * 8 + tail.length), digest = createHash('sha256');
  await run('init', large);
  for (let i = 0; i < 8; i++) { await part(large, i, chunk); digest.update(chunk); }
  await part(large, 8, tail); digest.update(tail);
  const before = await run('status', large); assert.equal((before.match(/^PART /gm) || []).length, 9);
  await part(large, 0, chunk); // An identical retry must not append bytes twice.
  await run('finish', large); await wait(large);
  assert.equal((await stat(large.target)).size, large.size); assert.equal(await fileHash(large.target), digest.digest('hex'));
  const receipt = await run('status', large); assert.match(receipt, /STATE complete/); assert.match(receipt, /^RESULT /m);
  assert.equal(await run('finish', large), receipt); await run('cleanup', large); checks++; console.log('PASS 128 MiB binary merge, SHA-256, ordered tail, duplicate part, repeat finish and cleanup');

  const collision = session('existing.bin', 6, 3); await writeFile(collision.target, 'original');
  assert.match(await run('init', collision, {}, false), /ERROR file_exists/);
  await run('init', collision, { overwrite: true }); await part(collision, 0, Buffer.from('abc')); await part(collision, 1, Buffer.from('def'));
  await run('finish', collision); await wait(collision, 'failed'); assert.equal(await readFile(collision.target, 'utf8'), 'original');
  await run('finish', collision, { overwrite: true }); await wait(collision); assert.equal(await readFile(collision.target, 'utf8'), 'abcdef'); await run('cleanup', collision); checks++; console.log('PASS existing target preserved until explicit overwrite, retry uses retained chunks');

  const damaged = session('damaged.bin', 6, 3); await run('init', damaged);
  assert.match(await part(damaged, 0, Buffer.from('abc'), true), /ERROR upload_part_invalid/);
  await part(damaged, 0, Buffer.from('abc')); assert.match(await run('finish', damaged, {}, false), /ERROR upload_incomplete/);
  await part(damaged, 1, Buffer.from('def')); await writeFile(path.join(damaged.directory, 'part-1'), 'BAD');
  await run('finish', damaged); await wait(damaged, 'failed'); assert.equal(await stat(damaged.target).then(() => true, () => false), false);
  await run('cleanup', damaged); checks++; console.log('PASS wrong hash, missing chunk and tampering never publish a partial target');

  const recovery = session('literal $(false) & quote\' 中文.bin', 6, 3); await run('init', recovery);
  await part(recovery, 0, Buffer.from('abc')); await part(recovery, 1, Buffer.from('def'));
  // Simulate a process dying with an incomplete assembly: no flock remains held.
  await writeFile(path.join(recovery.directory, 'state'), 'merging\n'); await writeFile(path.join(recovery.directory, 'assembled'), 'partial');
  assert.match(await run('status', recovery), /STATE failed/);
  await run('finish', recovery); await wait(recovery); assert.equal(await readFile(recovery.target, 'utf8'), 'abcdef');
  // Simulate publication having happened just before the result receipt was saved.
  await unlink(path.join(recovery.directory, 'result')); await writeFile(path.join(recovery.directory, 'state'), 'failed\n');
  await writeFile(path.join(recovery.directory, 'part-0'), 'abc'); await writeFile(path.join(recovery.directory, 'part-1'), 'def');
  await run('finish', recovery); await wait(recovery); assert.equal(await readFile(recovery.target, 'utf8'), 'abcdef');
  await run('cleanup', recovery); checks++; console.log('PASS interrupted merge, publication receipt recovery and literal shell punctuation in filenames');

  const guarded = session('guarded.bin', 3, 3); await run('init', guarded);
  assert.match(await run('status', { ...guarded, guard: '0'.repeat(64) }, {}, false), /ERROR upload_directory_changed/);
  await writeFile(path.join(guarded.directory, 'user-data.txt'), 'preserve me');
  assert.match(await run('cleanup', guarded, {}, false), /ERROR upload_cleanup_refused/);
  assert.equal(await readFile(path.join(guarded.directory, 'user-data.txt'), 'utf8'), 'preserve me'); checks++; console.log('PASS scope guard and cleanup refuse unrelated files');

  const cleanup = session('cleanup.bin', 6, 3); await run('init', cleanup);
  await part(cleanup, 0, Buffer.from('abc')); await part(cleanup, 1, Buffer.from('def'));
  // Simulate a command timing out after chunks and the receipt were partially removed.
  await unlink(path.join(cleanup.directory, 'part-0')); await unlink(path.join(cleanup.directory, 'meta')); await unlink(path.join(cleanup.directory, 'state'));
  await run('cleanup', cleanup); await run('cleanup', cleanup);
  assert.equal(await stat(cleanup.directory).then(() => true, () => false), false); checks++; console.log('PASS interrupted cleanup is retryable after metadata is removed');
  await writeFile(path.join(output, 'upload-assembly-report.json'), JSON.stringify({ checks, root, largeBytes: large.size, sha256: await fileHash(large.target), files: await readdir(root) }, null, 2));
  console.log('Assembly checks passed: ' + checks);
} catch (e) { console.error('Fixture directory: ' + root); throw e; }
