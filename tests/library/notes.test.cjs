'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { DurableStore } = require('../../apps/reader/src/app/storage/index.cjs');
const {
  LibraryManager,
} = require('../../apps/reader/src/app/library/index.cjs');
const {
  ReadingManager,
} = require('../../apps/reader/src/app/library/reading.cjs');
const {
  NotesManager,
  validNoteRequest,
} = require('../../apps/reader/src/app/library/notes.cjs');

const body = '第一章 渡口\n左岸。候船到此！右岸。\n';
const selection = {
  start: { chapterId: 'chapter-1', blockIndex: 0, offset: 3 },
  end: { chapterId: 'chapter-1', blockIndex: 0, offset: 8 },
};
const envelope = (html = '', sources = [], importedAnnotationIds = []) =>
  JSON.stringify({ schemaVersion: 1, html, sources, importedAnnotationIds });
const save = (notes, bookId, expectedRevision, document) =>
  notes.save({ bookId, expectedRevision, document });
const revisionFile = (root, bookId, revision) =>
  path.join(
    root,
    'data',
    `note-${bookId}`,
    `revision-${String(revision).padStart(16, '0')}.json`,
  );
const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup(t, checkpoint) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  function reopen(checkpoint) {
    const store = new DurableStore({
      root: path.join(root, 'data'),
      schemaVersion: 1,
      schemas: {
        1: (data) =>
          data !== null && typeof data === 'object' && !Array.isArray(data),
      },
      checkpoint,
    });
    const library = new LibraryManager({ root, store });
    const reading = new ReadingManager({ root, store, library });
    const notes = new NotesManager({ store, library, reading });
    return { store, library, reading, notes };
  }
  const managers = reopen(checkpoint);
  async function source(name, text = body) {
    const file = path.join(root, name);
    await fs.writeFile(file, text);
    return file;
  }
  const book = await managers.library.importFile(await source('synthetic.txt'));
  return { root, reopen, source, book, ...managers };
}
const createSource = (notes, book, range = selection) =>
  notes.createSource({
    bookId: book.bookId,
    contentHash: book.contentHash,
    range,
  });

test('S04-A1/A2: two books, five HTML formats and empty notes survive real-disk restart', async (t) => {
  const { notes, book, library, source, reopen, store } = await setup(t);
  const other = await library.importFile(
    await source('other.txt', '第二章\n合成的另一本书。'),
  );
  const empty = await notes.load({ bookId: book.bookId });
  assert.deepEqual(empty, {
    bookId: book.bookId,
    revision: 0,
    document: envelope(),
    updatedAt: null,
    resolutions: {},
  });
  assert.equal(
    await store.load(`note-${book.bookId}`),
    null,
    'empty load does not write',
  );
  const html =
    '<p>段落 &amp; 中文 😀</p><h2>标题</h2><ul><li>列表</li></ul><blockquote>引用</blockquote><p><strong>加粗</strong></p>';
  const document = envelope(html);
  const first = await save(notes, book.bookId, 0, document);
  const second = await save(
    notes,
    other.bookId,
    0,
    envelope('<p>separate</p>'),
  );
  assert.equal(first.document, document);
  assert.equal(first.revision, 1);
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
  assert.deepEqual(await reopen().notes.load({ bookId: book.bookId }), first);
  assert.deepEqual(await reopen().notes.load({ bookId: other.bookId }), second);
  assert.equal((await store.load(`note-${book.bookId}`)).schemaVersion, 1);
  const cleared = await save(notes, book.bookId, 1, envelope());
  assert.deepEqual(await reopen().notes.load({ bookId: book.bookId }), cleared);
  assert.deepEqual(await notes.load({ bookId: other.bookId }), second);
});

test('S04-A4: main-created immutable snapshots resolve exactly, fallback after replacement and remain readable when lost', async (t) => {
  const { notes, reading, book, library, source, reopen, root, store } =
    await setup(t);
  const anchor = await createSource(notes, book);
  assert.equal(anchor.exact, '候船到此！');
  assert.equal(anchor.bookId, book.bookId);
  assert.equal(anchor.source.title, book.title);
  assert.deepEqual(anchor.range, selection);
  const document = envelope('<blockquote>候船到此！</blockquote>', [anchor]);
  const first = await save(notes, book.bookId, 0, document);
  assert.deepEqual(first.resolutions[anchor.anchorId], {
    status: 'exact',
    range: selection,
  });
  const replaced = await library.replaceFile(
    book.bookId,
    await source(
      'replacement.txt',
      '第一章 渡口\n改版说明。\n绕新路，候船到此！\n',
    ),
  );
  const fallback = await reopen().notes.load({ bookId: book.bookId });
  assert.equal(fallback.document, document);
  assert.equal(fallback.resolutions[anchor.anchorId].status, 'fallback');
  assert.equal(
    (await store.load(`note-${book.bookId}`)).revision,
    1,
    'resolution does not write',
  );
  await fs.unlink(path.join(root, 'books', replaced.fileName));
  const lost = await notes.load({ bookId: book.bookId });
  assert.equal(lost.document, document);
  assert.deepEqual(lost.resolutions[anchor.anchorId], {
    status: 'lost',
    reason: 'book-unavailable',
  });
  const edited = await save(
    notes,
    book.bookId,
    1,
    envelope('<p>still editable</p>', [anchor]),
  );
  assert.deepEqual(edited.resolutions, lost.resolutions);
  await library.remove(book.bookId, true);
  assert.equal(
    (await notes.load({ bookId: book.bookId })).document,
    edited.document,
  );
  const catalog = await store.load('library');
  await store.save('library', { ...catalog.data, books: [] }, catalog.revision);
  assert.equal(
    (await notes.load({ bookId: book.bookId })).document,
    edited.document,
  );
  await assert.rejects(
    save(notes, book.bookId, edited.revision, envelope()),
    /找不到/,
  );
  assert.equal(
    (await store.load(`note-${book.bookId}`)).revision,
    edited.revision,
  );
  // An unrelated content failure must not be converted to a harmless lost state.
  reading.verifiedContent = async () => {
    throw Object.assign(new Error('unexpected'), { code: 'EIO' });
  };
  await assert.rejects(notes.load({ bookId: book.bookId }), { code: 'EIO' });
});

test('persisted anchor IDs cannot be edited, including after removal/restart; reordered JSON is equivalent', async (t) => {
  const { notes, book, reopen, store } = await setup(t);
  const anchor = await createSource(notes, book);
  await save(notes, book.bookId, 0, envelope('<p>citation</p>', [anchor]));
  for (const patch of [
    { exact: 'different' },
    { prefix: 'changed' },
    { contentHash: 'f'.repeat(64) },
    { source: { ...anchor.source, title: 'edited title' } },
    { range: { ...anchor.range, start: { ...anchor.range.start, offset: 2 } } },
  ]) {
    await assert.rejects(
      save(notes, book.bookId, 1, envelope('', [{ ...anchor, ...patch }])),
      /快照/,
    );
    assert.equal((await store.load(`note-${book.bookId}`)).revision, 1);
  }
  const reordered = Object.fromEntries(Object.entries(anchor).reverse());
  await save(notes, book.bookId, 1, envelope('<p>user text</p>', [reordered]));
  await save(notes, book.bookId, 2, envelope('<p>deleted citation</p>'));
  await assert.rejects(
    save(
      reopen().notes,
      book.bookId,
      3,
      envelope('', [{ ...anchor, exact: 'altered after removal' }]),
    ),
    /快照/,
  );
  const restored = await save(
    reopen().notes,
    book.bookId,
    3,
    envelope('', [anchor]),
  );
  assert.equal(restored.resolutions[anchor.anchorId].status, 'exact');
});

test('createSource captures input and runs exclusively with content replacement, rejecting stale hashes and invalid positions', async (t) => {
  const { notes, book, reading, library, source } = await setup(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const blocker = reading.runExclusive(() => gate);
  const request = {
    bookId: book.bookId,
    contentHash: book.contentHash,
    range: clone(selection),
  };
  const pending = notes.createSource(request);
  request.range.start.offset = 0;
  release();
  await blocker;
  assert.equal((await pending).exact, '候船到此！');
  const file = await source(
    'replacement.txt',
    '第一章 渡口\n这是不同的合成文字。',
  );
  const replacement = reading.runExclusive(() =>
    library.replaceFile(book.bookId, file),
  );
  await assert.rejects(createSource(notes, book), /正文已变更/);
  const newBook = await replacement;
  await assert.rejects(
    createSource(notes, newBook, {
      start: { ...selection.start, blockIndex: 99 },
      end: { ...selection.end, blockIndex: 99 },
    }),
    { code: 'INVALID_POSITION' },
  );
  assert.equal(
    (
      await createSource(notes, newBook, {
        start: { ...selection.start, offset: 0 },
        end: { ...selection.end, offset: 2 },
      })
    ).exact,
    '这是',
  );
});

test('strict request/envelope/source validation is bounded and rejects extra keys and cross-book anchors without writes', async (t) => {
  const { notes, book, store } = await setup(t);
  const bookId = book.bookId;
  const anchor = await createSource(notes, book);
  const valid = {
    bookId,
    expectedRevision: 0,
    document: envelope('', [anchor]),
  };
  assert.equal(validNoteRequest('saveNote', valid), true);
  const malformedEnvelopes = [
    '',
    '<p>legacy HTML is load-only</p>',
    '{',
    'null',
    '[]',
    '"text"',
    JSON.stringify({ ...JSON.parse(envelope()), schemaVersion: 2 }),
    JSON.stringify({ ...JSON.parse(envelope()), extra: true }),
    JSON.stringify({ ...JSON.parse(envelope()), sources: {} }),
    envelope('', [anchor, anchor]),
    envelope('', [{ ...anchor, bookId: `book-${'z'.repeat(32)}` }]),
    envelope('', [{ ...anchor, extra: true }]),
    envelope('', [{ ...anchor, schemaVersion: 2 }]),
    envelope('', [{ ...anchor, adapterVersion: 0 }]),
    envelope('', [{ ...anchor, exact: '' }]),
    envelope('', [{ ...anchor, prefix: 'x'.repeat(33) }]),
    envelope('', [{ ...anchor, source: { ...anchor.source, private: true } }]),
    envelope('', [{ ...anchor, range: { ...anchor.range, extra: true } }]),
    envelope('', [{ ...anchor, createdAt: 'bad' }]),
    envelope('', [{ ...anchor, contentHash: '../unsafe' }]),
    envelope('', [], ['not-an-annotation']),
    envelope(
      '',
      [],
      [
        'annotation-00000000-0000-0000-0000-000000000001',
        'annotation-00000000-0000-0000-0000-000000000001',
      ],
    ),
    envelope('x'.repeat(500_001)),
    envelope(
      '',
      Array.from({ length: 1001 }, (_, i) => ({
        ...anchor,
        anchorId: `anchor-00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      })),
    ),
    envelope(
      '',
      [],
      Array.from(
        { length: 5001 },
        (_, i) =>
          `annotation-00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      ),
    ),
  ];
  for (const document of malformedEnvelopes) {
    assert.equal(validNoteRequest('saveNote', { ...valid, document }), false);
    await assert.rejects(notes.save({ ...valid, document }));
  }
  for (const request of [
    null,
    [],
    {},
    { ...valid, extra: true },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 1.5 },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, bookId: '../book' },
    { ...valid, document: {} },
  ]) {
    assert.equal(validNoteRequest('saveNote', request), false);
    await assert.rejects(notes.save(request));
  }
  for (const method of ['loadNote', 'createNoteSource', 'unknown'])
    assert.equal(validNoteRequest(method, valid), false);
  assert.equal(validNoteRequest('unknown', { bookId }), false);
  assert.equal(validNoteRequest('loadNote', { bookId, extra: true }), false);
  await assert.rejects(notes.load({ bookId, extra: true }));
  assert.equal(
    validNoteRequest('createNoteSource', {
      bookId,
      contentHash: book.contentHash,
      range: selection,
    }),
    true,
  );
  for (const request of [
    {
      bookId,
      contentHash: book.contentHash,
      range: selection,
      html: 'injected',
    },
    { bookId, contentHash: '', range: selection },
    {
      bookId,
      contentHash: book.contentHash,
      range: { start: selection.end, end: selection.start },
    },
    {
      bookId,
      contentHash: book.contentHash,
      range: {
        start: selection.start,
        end: { ...selection.end, chapterId: 'chapter-2' },
      },
    },
  ]) {
    assert.equal(validNoteRequest('createNoteSource', request), false);
    await assert.rejects(notes.createSource(request));
  }
  assert.equal(await store.load(`note-${bookId}`), null);
  const annotationId = 'annotation-00000000-0000-0000-0000-000000000001';
  const saved = await save(
    notes,
    bookId,
    0,
    envelope('', [anchor], [annotationId]),
  );
  assert.deepEqual(JSON.parse(saved.document).importedAnnotationIds, [
    annotationId,
  ]);
});

test('out-of-order saves and separate managers cannot overwrite a newer revision; input is captured before queuing', async (t) => {
  const { notes, book, reopen } = await setup(t);
  const first = await save(notes, book.bookId, 0, envelope('<p>first</p>'));
  const newest = await save(
    reopen().notes,
    book.bookId,
    1,
    envelope('<p>newest arrived first</p>'),
  );
  await assert.rejects(
    save(
      notes,
      book.bookId,
      first.revision,
      envelope('<p>late older request</p>'),
    ),
    { code: 'STALE_REVISION' },
  );
  assert.deepEqual(await notes.load({ bookId: book.bookId }), newest);
  const request = {
    bookId: book.bookId,
    expectedRevision: 2,
    document: envelope('<p>captured</p>'),
  };
  const pending = notes.save(request);
  request.document = envelope('<p>mutated</p>');
  assert.equal(JSON.parse((await pending).document).html, '<p>captured</p>');
  const results = await Promise.allSettled([
    save(notes, book.bookId, 3, envelope('<p>race one</p>')),
    save(reopen().notes, book.bookId, 3, envelope('<p>race two</p>')),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'STALE_REVISION',
  );
  assert.equal(
    (await reopen().notes.load({ bookId: book.bookId })).revision,
    4,
  );
});

test('unknown or malformed saved documents fail closed on load AND save, without changing any revision', async (t) => {
  const { notes, book, store, root } = await setup(t);
  const anchor = await createSource(notes, book);
  for (const [document, extras] of [
    [JSON.stringify({ ...JSON.parse(envelope()), schemaVersion: 99 }), {}],
    ['{"schemaVersion":1,', {}],
    [
      JSON.stringify({
        ...JSON.parse(envelope()),
        sources: [{ anchorId: 'bad' }],
      }),
      {},
    ],
    [envelope('', [anchor]), { sourceSnapshots: [] }],
    [envelope(), { sourceSnapshots: null }],
    [envelope(), { updatedAt: 'not-a-date' }],
  ]) {
    const previous = await store.load(`note-${book.bookId}`);
    const record = await store.save(
      `note-${book.bookId}`,
      {
        document,
        updatedAt: new Date().toISOString(),
        ...extras,
      },
      previous?.revision ?? 0,
    );
    const file = revisionFile(root, book.bookId, record.revision);
    const bytes = await fs.readFile(file);
    await assert.rejects(notes.load({ bookId: book.bookId }));
    await assert.rejects(
      save(
        notes,
        book.bookId,
        record.revision,
        envelope('<p>must not overwrite</p>'),
      ),
    );
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal(
      (await store.load(`note-${book.bookId}`)).revision,
      record.revision,
    );
  }
});

test('legacy raw HTML/empty records migrate only in memory; failed migration save preserves old data and can retry', async (t) => {
  for (const html of ['', '<p>legacy <strong>bold</strong> &amp; 中文</p>']) {
    await t.test(html ? 'HTML' : 'empty', async (t) => {
      const { notes, store, root, book, reopen } = await setup(t);
      const id = `note-${book.bookId}`;
      await store.save(
        id,
        { document: html, updatedAt: '2026-01-01T00:00:00.000Z', noteId: id },
        0,
      );
      const original = await store.load(id);
      const bytes = await fs.readFile(revisionFile(root, book.bookId, 1));
      const migrated = await notes.load({ bookId: book.bookId });
      assert.equal(migrated.revision, 1);
      assert.equal(migrated.document, envelope(html));
      assert.deepEqual(await store.load(id), original);
      const faulty = reopen((stage) => {
        if (stage === 'after-file-sync')
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      });
      await assert.rejects(
        save(faulty.notes, book.bookId, 1, migrated.document),
        (error) => error.code === 'IO_ERROR' && error.cause.code === 'ENOSPC',
      );
      assert.deepEqual(await store.load(id), original);
      assert.deepEqual(
        await reopen().notes.load({ bookId: book.bookId }),
        migrated,
      );
      const saved = await save(notes, book.bookId, 1, migrated.document);
      assert.equal(saved.revision, 2);
      assert.deepEqual(
        await fs.readFile(revisionFile(root, book.bookId, 1)),
        bytes,
      );
      assert.deepEqual(
        await reopen().notes.load({ bookId: book.bookId }),
        saved,
      );
    });
  }
});

test('ENOSPC/EACCES before and after publication preserve DurableStore ambiguity and require retry reload', async (t) => {
  for (const failure of ['ENOSPC', 'EACCES']) {
    for (const stage of [
      'before-file-sync',
      'after-file-sync',
      'after-publish',
      'after-directory-sync',
    ]) {
      await t.test(`${failure} at ${stage}`, async (t) => {
        const { notes, store, root, book, reopen } = await setup(t);
        const confirmed = await save(
          notes,
          book.bookId,
          0,
          envelope('<p>confirmed</p>'),
        );
        const bytes = await fs.readFile(revisionFile(root, book.bookId, 1));
        const candidate = envelope('<p>possibly committed</p>');
        const faulty = reopen((current) => {
          if (current === stage)
            throw Object.assign(new Error(failure), { code: failure });
        });
        await assert.rejects(
          save(faulty.notes, book.bookId, 1, candidate),
          (error) =>
            error.code === 'IO_ERROR' &&
            error.cause.code === failure &&
            /Reload before retrying/.test(error.message),
        );
        const loaded = await reopen().notes.load({ bookId: book.bookId });
        const published =
          stage === 'after-publish' || stage === 'after-directory-sync';
        assert.equal(loaded.revision, published ? 2 : 1);
        assert.equal(
          loaded.document,
          published ? candidate : confirmed.document,
        );
        assert.deepEqual(
          await fs.readFile(revisionFile(root, book.bookId, 1)),
          bytes,
        );
        if (published)
          await assert.rejects(
            save(notes, book.bookId, 1, envelope('<p>unsafe retry</p>')),
            { code: 'STALE_REVISION' },
          );
        const retry = await save(
          reopen().notes,
          book.bookId,
          loaded.revision,
          envelope('<p>reloaded retry</p>'),
        );
        assert.equal(retry.revision, loaded.revision + 1);
        assert.equal(
          (await store.load(`note-${book.bookId}`)).revision,
          retry.revision,
        );
      });
    }
  }
});

async function killDuringSave(t, root, bookId, stage) {
  const child = fork(
    path.join(__dirname, '../storage/notes-crash-child.cjs'),
    [root, bookId, stage],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Child timeout: ${stderr}`));
    }, 10000);
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited ${code}: ${stderr}`));
    });
  });
  assert.deepEqual(message, { stage });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
}

test('S04-A3: real child SIGKILL during note save and legacy migration preserves all confirmed revisions', async (t) => {
  for (const legacy of [false, true]) {
    for (const stage of [
      'before-file-sync',
      'after-file-sync',
      'after-publish',
      'after-directory-sync',
    ]) {
      await t.test(
        `${legacy ? 'legacy migration' : 'note save'} at ${stage}`,
        async (t) => {
          const { notes, book, store, root, reopen } = await setup(t);
          const document = legacy
            ? '<p>legacy confirmed</p>'
            : envelope('<p>confirmed</p>');
          if (legacy)
            await store.save(
              `note-${book.bookId}`,
              { document, updatedAt: '2026-01-01T00:00:00.000Z' },
              0,
            );
          else await save(notes, book.bookId, 0, document);
          const bytes = await fs.readFile(revisionFile(root, book.bookId, 1));
          await killDuringSave(t, root, book.bookId, stage);
          assert.deepEqual(
            await fs.readFile(revisionFile(root, book.bookId, 1)),
            bytes,
          );
          const recovered = await reopen().notes.load({ bookId: book.bookId });
          const published =
            stage === 'after-publish' || stage === 'after-directory-sync';
          assert.equal(recovered.revision, published ? 2 : 1);
          assert.equal(
            JSON.parse(recovered.document).html,
            published
              ? '<p>unacknowledged child edit</p>'
              : legacy
                ? document
                : '<p>confirmed</p>',
          );
          if (published)
            await assert.rejects(
              save(notes, book.bookId, 1, envelope('<p>stale</p>')),
              { code: 'STALE_REVISION' },
            );
          const saved = await save(
            reopen().notes,
            book.bookId,
            recovered.revision,
            envelope('<p>safe recovery</p>'),
          );
          assert.equal(saved.revision, recovered.revision + 1);
        },
      );
    }
  }
});
