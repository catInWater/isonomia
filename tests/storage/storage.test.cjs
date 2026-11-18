'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { DurableStore, validateId } = require('../../apps/reader/src/app/storage/index.cjs');
const schemas = {
  1: (data) => typeof data?.text === 'string',
  2: (data) => typeof data?.text === 'string' && data.upgraded === true,
};
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DurableStore({ root, schemaVersion: 1, schemas, ...options });
  return { root, store };
}
const code = (expected) => (error) => error.code === expected;
const revisionFile = (root, n) => path.join(root, 'book', `revision-${String(n).padStart(16, '0')}.json`);

async function terminateAt(t, root, mode, stage) {
  const child = fork(path.join(__dirname, 'crash-child.cjs'), [root, mode, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Child timeout: ${stderr}`)); }, 10000);
    child.once('message', (value) => { clearTimeout(timer); resolve(value); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (exit) => { clearTimeout(timer); reject(new Error(`Early exit ${exit}: ${stderr}`)); });
  });
  assert.equal(message.error, undefined);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  return message;
}

test('S00-A5 real-disk round trip, isolated IDs, captured input and stale revisions', async (t) => {
  const { root, store } = await setup(t);
  assert.equal(await store.load('book'), null);
  const data = { text: '中文', nodes: [1, true, null] };
  const first = store.save('book', data, 0);
  data.text = 'mutated';
  assert.equal((await first).data.text, '中文');
  await store.save('other', { text: 'separate' }, 0);
  const secondStore = new DurableStore({ root, schemaVersion: 1, schemas });
  const results = await Promise.allSettled([
    store.save('book', { text: 'winner' }, 1),
    secondStore.save('book', { text: 'stale' }, 1),
  ]);
  assert.equal(results[0].value.revision, 2);
  assert.equal(results[1].reason.code, 'STALE_REVISION');
  assert.equal((await secondStore.load('book')).data.text, 'winner');
  assert.equal((await store.load('other')).data.text, 'separate');
  await assert.rejects(store.save('book', { text: 'old' }, 0), code('STALE_REVISION'));
});

test('rejects unsafe IDs, symlinks, lossy JSON and invalid schema without a write', async (t) => {
  const { root, store } = await setup(t);
  for (const id of ['../x', '/tmp/x', 'a/b', 'a\\b', '.', 'CON', 'NUL', 'x.', '', 'a'.repeat(81)]) {
    assert.throws(() => validateId(id), code('INVALID_ID'));
  }
  for (const data of [{ text: 4 }, { text: 'x', value: undefined }, { text: 'x', value: NaN }, { text: 'x', value: new Date() }]) {
    await assert.rejects(store.save('book', data, 0));
  }
  const cyclic = { text: 'x' }; cyclic.self = cyclic;
  await assert.rejects(store.save('book', cyclic, 0), code('INVALID_DATA'));
  await fs.symlink(os.tmpdir(), path.join(root, 'book'), 'dir');
  await assert.rejects(store.load('book'), code('UNSAFE_PATH'));
});

test('disk full and access errors reject, preserve confirmed data, and do not poison queue', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'confirmed' }, 0);
  for (const failure of ['ENOSPC', 'EACCES']) {
    const faulty = new DurableStore({ root, schemaVersion: 1, schemas,
      checkpoint: async (stage) => {
        if (stage === 'before-file-sync') throw Object.assign(new Error(failure), { code: failure });
      },
    });
    await assert.rejects(faulty.save('book', { text: 'unconfirmed' }, 1), (error) => error.code === 'IO_ERROR' && error.cause.code === failure);
    assert.equal((await store.load('book')).data.text, 'confirmed');
  }
  assert.equal((await store.save('book', { text: 'retry' }, 1)).revision, 2);
});

test('actual publication collision never overwrites an existing file', async (t) => {
  let root;
  const fixture = await setup(t, { checkpoint: async (stage, { name }) => {
    if (stage === 'after-file-sync') await fs.writeFile(path.join(root, 'book', name), 'external occupant', { flag: 'wx' });
  } });
  root = fixture.root;
  await assert.rejects(fixture.store.save('book', { text: 'x' }, 0), code('IO_ERROR'));
  assert.equal(await fs.readFile(revisionFile(root, 1), 'utf8'), 'external occupant');
});

test('post-publication failure requires reload and rejects stale retry', async (t) => {
  const { root, store } = await setup(t, { checkpoint: async (stage) => {
    if (stage === 'after-publish') throw new Error('directory flush failure');
  } });
  await assert.rejects(store.save('book', { text: 'possibly committed' }, 0), code('IO_ERROR'));
  const reopened = new DurableStore({ root, schemaVersion: 1, schemas });
  assert.equal((await reopened.load('book')).revision, 1);
  await assert.rejects(reopened.save('book', { text: 'retry' }, 0), code('STALE_REVISION'));
});

test('S00-A4 corrupt latest is never silently replaced; recovery is validated, explicit and preserves originals', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'first' }, 0);
  await store.save('book', { text: 'second' }, 1);
  const corrupt = '{broken';
  await fs.writeFile(revisionFile(root, 2), corrupt);
  await assert.rejects(store.load('book'), code('RECOVERY_REQUIRED'));
  await assert.rejects(store.save('book', { text: 'unsafe overwrite' }, 2), code('RECOVERY_REQUIRED'));
  const candidates = await store.listRecovery('book');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].valid, false);
  const selected = candidates[0];
  await assert.rejects(store.recover('book', { ...selected, expectedRevision: 1 }), code('STALE_REVISION'));
  await assert.rejects(store.recover('book', { ...selected, checksum: '0'.repeat(64), expectedRevision: 2 }), code('INVALID_SELECTION'));
  await assert.rejects(store.recover('book', { ...selected, name: '../outside', expectedRevision: 2 }), code('INVALID_SELECTION'));
  const recovered = await store.recover('book', { ...selected, expectedRevision: 2 });
  assert.equal(recovered.revision, 3);
  assert.equal(recovered.data.text, 'first');
  assert.equal(await fs.readFile(revisionFile(root, 2), 'utf8'), corrupt);
  assert.equal((await store.load('book')).revision, 3);
});

test('checksums detect valid JSON tampering and recovery revalidates selected file', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'original' }, 0);
  const [selected] = await store.listRecovery('book');
  const record = JSON.parse(await fs.readFile(revisionFile(root, 1), 'utf8'));
  record.data.text = 'tampered';
  await fs.writeFile(revisionFile(root, 1), JSON.stringify(record));
  await assert.rejects(store.recover('book', { ...selected, expectedRevision: 1 }), code('CORRUPT'));
  await assert.rejects(store.load('book'), code('RECOVERY_REQUIRED'));
});

test('S00-A4 migration failure rolls back, retry migrates and snapshot can explicitly restore old schema', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'old' }, 0);
  const original = await fs.readFile(revisionFile(root, 1), 'utf8');
  const bad = new DurableStore({ root, schemaVersion: 2, schemas, migrations: { 1: () => ({ text: 'invalid' }) } });
  await assert.rejects(bad.save('book', { text: 'new', upgraded: true }, 1), code('MIGRATION_REQUIRED'));
  await assert.rejects(bad.migrate('book'), code('MIGRATION_FAILED'));
  assert.equal((await store.load('book')).schemaVersion, 1);
  assert.equal(await fs.readFile(revisionFile(root, 1), 'utf8'), original);
  const next = new DurableStore({ root, schemaVersion: 2, schemas, migrations: { 1: (data) => ({ ...data, upgraded: true }) } });
  assert.equal((await next.migrate('book')).revision, 2);
  assert.equal((await next.migrate('book')).revision, 2);
  const snapshot = (await next.listRecovery('book')).find((entry) => entry.name.startsWith('snapshot-'));
  assert.equal(snapshot.valid, true);
  assert.equal((await next.recover('book', { ...snapshot, expectedRevision: 2 })).schemaVersion, 1);
  assert.equal((await next.migrate('book')).revision, 4);
});

test('real filesystem error preserves acknowledged revision', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'confirmed' }, 0);
  let blocked;
  const faulty = new DurableStore({ root, schemaVersion: 1, schemas, checkpoint: async (stage, { name }) => {
    if (stage === 'after-file-sync') {
      blocked = path.join(root, 'book', name);
      await fs.mkdir(blocked);
    }
  } });
  await assert.rejects(faulty.save('book', { text: 'unconfirmed' }, 1), (error) => error.code === 'IO_ERROR' && error.cause.code === 'EEXIST');
  assert.equal(JSON.parse(await fs.readFile(revisionFile(root, 1), 'utf8')).data.text, 'confirmed');
  await assert.rejects(store.load('book'), code('RECOVERY_REQUIRED'));
  await fs.rmdir(blocked);
  assert.equal((await store.load('book')).revision, 1);
});

test('multi-step migration validates every intermediate schema and retains original on interruption', async (t) => {
  const { root, store } = await setup(t);
  await store.save('book', { text: 'old' }, 0);
  const allSchemas = { ...schemas, 3: (data) => data?.final === true && data?.upgraded === true };
  const broken = new DurableStore({ root, schemaVersion: 3, schemas: allSchemas,
    migrations: { 1: (data) => ({ ...data, upgraded: true }), 2: () => { throw new Error('interrupted'); } },
  });
  await assert.rejects(broken.migrate('book'), code('MIGRATION_FAILED'));
  assert.equal((await store.load('book')).schemaVersion, 1);
  const fixed = new DurableStore({ root, schemaVersion: 3, schemas: allSchemas,
    migrations: { 1: (data) => ({ ...data, upgraded: true }), 2: (data) => ({ ...data, final: true }) },
  });
  assert.equal((await fixed.migrate('book')).schemaVersion, 3);
  assert.equal((await fixed.load('book')).revision, 2);
});

for (const stage of ['before-file-sync', 'after-file-sync', 'after-publish', 'after-directory-sync', 'acknowledged']) {
  test(`S00-A5 SIGKILL during save at ${stage} preserves all acknowledged content`, async (t) => {
    const { root, store } = await setup(t);
    await store.save('book', { text: 'confirmed' }, 0);
    const message = await terminateAt(t, root, 'save', stage);
    const reopened = new DurableStore({ root, schemaVersion: 1, schemas });
    const value = await reopened.load('book');
    assert.ok([1, 2].includes(value.revision));
    assert.equal(value.data.text, value.revision === 1 ? 'confirmed' : 'new');
    assert.equal(JSON.parse(await fs.readFile(revisionFile(root, 1), 'utf8')).data.text, 'confirmed');
    if (stage === 'acknowledged') {
      assert.equal(message.acknowledged, 2);
      assert.equal(value.revision, 2);
    }
    if (['before-file-sync', 'after-file-sync'].includes(stage)) assert.equal(value.revision, 1);
  });
}
for (const stage of ['after-snapshot', 'after-migration-step', 'after-publish']) {
  test(`S00-A4 SIGKILL migration at ${stage} leaves validated rollback source`, async (t) => {
    const { root, store } = await setup(t);
    await store.save('book', { text: 'confirmed' }, 0);
    await terminateAt(t, root, 'migrate', stage);
    const reopened = new DurableStore({ root, schemaVersion: 2, schemas, migrations: { 1: (data) => ({ ...data, upgraded: true }) } });
    const value = await reopened.load('book');
    assert.ok([1, 2].includes(value.revision));
    const snapshot = (await reopened.listRecovery('book')).find((entry) => entry.name.startsWith('snapshot-'));
    assert.equal(snapshot.valid, true);
    await reopened.recover('book', { ...snapshot, expectedRevision: value.revision });
    assert.equal((await reopened.load('book')).data.text, 'confirmed');
    assert.equal((await reopened.load('book')).schemaVersion, 1);
  });
}
