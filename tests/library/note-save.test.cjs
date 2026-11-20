'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  NoteSaveSession,
} = require('../../apps/reader-ui/src/app/note-save.ts');
const note = (document = 'initial', revision = 1, bookId = 'book-a') => ({
  bookId,
  revision,
  document,
  updatedAt: null,
  resolutions: {},
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('S04-A1/A2 autosave begins after idle within 2s, coalesces rapid edits and only acknowledges latest content', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const pending = deferred();
  const session = new NoteSaveSession(
    'book-a',
    {
      loadNote: async () => note(),
      saveNote: async (request) => {
        calls.push(request);
        return calls.length === 1 ? pending.promise : note(request.document, 3);
      },
    },
    () => {},
  );
  t.after(() => session.dispose());
  assert.equal(await session.load(), true);
  session.update('first');
  t.mock.timers.tick(1000);
  session.update('second');
  t.mock.timers.tick(1499);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].document, 'second');
  assert.equal(session.state, 'saving');
  session.update('third');
  assert.notEqual(session.state, 'saved');
  const flushed = session.flush();
  pending.resolve(note('second', 2));
  assert.equal(await flushed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedRevision, 2);
  assert.equal(calls[1].document, 'third');
  assert.equal(session.state, 'saved');
});

test('S04-A3 ambiguous acknowledgement reloads before retry, does not overwrite concurrent revisions', async (t) => {
  let persisted = note();
  let writes = 0;
  const session = new NoteSaveSession(
    'book-a',
    {
      loadNote: async () => persisted,
      saveNote: async (request) => {
        writes++;
        persisted = note(request.document, 2);
        throw new Error('directory sync failed');
      },
    },
    () => {},
  );
  t.after(() => session.dispose());
  await session.load();
  session.update('possibly committed');
  assert.equal(await session.flush(), false);
  assert.equal(session.state, 'failed');
  assert.equal(session.document, 'possibly committed');
  assert.equal(await session.flush(), true);
  assert.equal(writes, 1, 'already committed revision must not be duplicated');
  session.update('local unsaved');
  assert.equal(await session.flush(), false);
  persisted = note('other writer', 3);
  assert.equal(await session.flush(), false);
  assert.equal(writes, 2, 'retry must not clobber a different new revision');
  assert.equal(session.document, 'local unsaved');
});

test('S04-A2 failed publication preserves editable input and retries only after checking unchanged revision', async (t) => {
  let fail = true;
  const events = [];
  const session = new NoteSaveSession(
    'book-a',
    {
      loadNote: async () => {
        events.push('load');
        return note();
      },
      saveNote: async (request) => {
        events.push('save');
        if (fail) throw new Error('ENOSPC');
        return note(request.document, 2);
      },
    },
    () => {},
  );
  t.after(() => session.dispose());
  await session.load();
  session.update('first local');
  assert.equal(await session.flush(), false);
  session.update('latest local');
  assert.equal(session.state, 'failed');
  fail = false;
  assert.equal(await session.flush(), true);
  assert.deepEqual(events, ['load', 'save', 'load', 'save']);
  assert.equal(session.snapshot.document, 'latest local');
});

test('S04-A1 separate sessions never mix books and navigation flush includes last keystroke', async (t) => {
  const calls = [];
  const bridge = {
    loadNote: async ({ bookId }) => note('', 0, bookId),
    saveNote: async (request) => {
      calls.push(request);
      return note(
        request.document,
        request.expectedRevision + 1,
        request.bookId,
      );
    },
  };
  const a = new NoteSaveSession('book-a', bridge, () => {});
  const b = new NoteSaveSession('book-b', bridge, () => {});
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  await Promise.all([a.load(), b.load()]);
  a.update('A');
  b.update('B');
  await Promise.all([a.flush(), b.flush()]);
  assert.deepEqual(
    calls.map(({ bookId, document }) => [bookId, document]),
    [
      ['book-a', 'A'],
      ['book-b', 'B'],
    ],
  );
});

test('S04-A2 initial load failure cannot save an empty replacement over unreadable notes', async (t) => {
  let writes = 0;
  const session = new NoteSaveSession(
    'book-a',
    {
      loadNote: async () => {
        throw new Error('RECOVERY_REQUIRED');
      },
      saveNote: async () => {
        writes++;
        return note();
      },
    },
    () => {},
  );
  t.after(() => session.dispose());
  assert.equal(await session.load(), false);
  session.update('unsafe replacement');
  assert.equal(await session.flush(), false);
  assert.equal(writes, 0);
  assert.equal(session.state, 'failed');
});
