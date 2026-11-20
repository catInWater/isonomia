const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isTrustedSender,
  validateRequest,
  allowRequest,
  rendererDocument,
} = require('../../apps/reader/src/app/api/security.ts');

const document = 'file:///opt/reader-ui/index.html';
test('S00-A6 IPC rejects subframes, external origins and unexpected arguments', () => {
  assert.equal(isTrustedSender(document + '#/about', true, document), true);
  for (const [url, main] of [
    [document, false],
    ['https://evil.test', true],
    ['file:///tmp/index.html', true],
    [document + '?spoof=1', true],
  ]) {
    assert.equal(isTrustedSender(url, main, document), false);
  }
  assert.doesNotThrow(() => validateRequest('version', []));
  assert.doesNotThrow(() =>
    validateRequest('libraryCover', [`book-${'a'.repeat(32)}`]),
  );
  assert.throws(() => validateRequest('libraryCover', ['/etc/passwd']));
  for (const method of ['quit', 'readFile', '__proto__']) {
    assert.throws(() => validateRequest(method, []));
  }
  assert.throws(() => validateRequest('version', ['../../private']));
  assert.throws(() =>
    validateRequest('load', ['reading-book-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
  );
});
const bookId = `book-${'a'.repeat(32)}`;
const highlightId = 'highlight-00000000-0000-4000-8000-000000000001';

test('S03 IPC exposes replacement, annotation listing and copying without raw file or record access', () => {
  for (const [method, args] of [
    ['libraryReplace', [bookId]],
    ['listAnnotations', [{ bookId }]],
    ['copyAnnotation', [{ bookId, highlightId }]],
  ]) {
    assert.doesNotThrow(() => validateRequest(method, args), method);
    assert.throws(
      () => validateRequest(method, [...args, 'extra argument']),
      method,
    );
  }
  for (const [label, method, args] of [
    ['renderer path', 'libraryReplace', [bookId, '/tmp/replacement.txt']],
    ['path instead of ID', 'libraryReplace', ['/tmp/replacement.txt']],
    [
      'unexpected list field',
      'listAnnotations',
      [{ bookId, path: '/tmp/book.txt' }],
    ],
    [
      'invalid highlight ID',
      'copyAnnotation',
      [{ bookId, highlightId: 'not-a-highlight-id' }],
    ],
    [
      'renderer clipboard text',
      'copyAnnotation',
      [{ bookId, highlightId, text: '直接复制' }],
    ],
  ]) {
    assert.throws(() => validateRequest(method, args), label);
  }
  const id = `annotations-${bookId}`;
  for (const [method, args] of [
    ['load', [id]],
    ['save', [id, {}, 0]],
    ['listRecovery', [id]],
    [
      'recover',
      [
        id,
        {
          name: 'revision-0000000000000001.json',
          checksum: 'a'.repeat(64),
          expectedRevision: 1,
        },
      ],
    ],
  ]) {
    assert.throws(() => validateRequest(method, args), method);
  }
});

test('S03 IPC validates annotation changes, revisions and half-open range shapes', () => {
  const start = { chapterId: 'chapter-1', blockIndex: 0, offset: 0 };
  const end = { ...start, offset: 3 };
  const create = {
    kind: 'create',
    contentHash: 'a'.repeat(64),
    range: { start, end },
    color: 'yellow',
    text: '批注',
  };
  const update = { kind: 'update', highlightId, color: 'blue', text: '新批注' };
  const request = { bookId, expectedRevision: 0, change: create };
  for (const change of [
    create,
    update,
    { kind: 'remove', highlightId },
    { kind: 'undo', highlightId },
  ]) {
    assert.doesNotThrow(
      () => validateRequest('changeAnnotation', [{ ...request, change }]),
      change.kind,
    );
  }
  for (const [label, change] of [
    ['unknown operation', { kind: 'overwrite' }],
    ['bad color', { ...create, color: 'orange' }],
    ['bad hash', { ...create, contentHash: 'bad' }],
    ['oversized text', { ...create, text: '字'.repeat(8_001) }],
    ['renderer anchor', { ...create, anchor: {} }],
    [
      'cross-chapter range',
      { ...create, range: { start, end: { ...end, chapterId: 'chapter-2' } } },
    ],
    ['reversed range', { ...create, range: { start: end, end: start } }],
    [
      'negative offset',
      { ...create, range: { start: { ...start, offset: -1 }, end } },
    ],
    [
      'unknown position field',
      { ...create, range: { start: { ...start, page: 1 }, end } },
    ],
    ['update range', { ...update, range: create.range }],
    ['undo extra data', { kind: 'undo', highlightId, text: '伪造恢复' }],
  ]) {
    assert.throws(
      () => validateRequest('changeAnnotation', [{ ...request, change }]),
      label,
    );
  }
  for (const expectedRevision of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      validateRequest('changeAnnotation', [{ ...request, expectedRevision }]),
    );
  }
});

test('S00-A6 production allows only bundled assets and blocks remote/local escapes', () => {
  assert.equal(allowRequest('file:///opt/reader-ui/main.js', document), true);
  assert.equal(
    allowRequest(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      document,
    ),
    true,
  );
  for (const url of [
    'https://evil.test/a',
    'http://localhost:4200',
    'file:///etc/passwd',
    'file:///opt/reader-ui/../secret',
    'file:///opt/reader-ui/%2e%2e/secret',
    'file:///opt/reader-ui/..%2fsecret',
    'file:///opt/reader-ui/..%5csecret',
    'data:text/html,evil',
    'javascript:alert(1)',
  ]) {
    assert.equal(allowRequest(url, document), false, url);
  }
});
test('development exception is restricted to the configured loopback port', () => {
  const dev = rendererDocument('/opt/reader', 4200);
  assert.equal(allowRequest('http://localhost:4200/main.js', dev), true);
  assert.equal(allowRequest('ws://localhost:4200/ws', dev), true);
  assert.equal(allowRequest('http://127.0.0.1:4200/main.js', dev), true);
  assert.equal(allowRequest('http://evil.localhost:4200/', dev), false);
  assert.equal(allowRequest('http://localhost.evil.test:4200/', dev), false);
  assert.equal(allowRequest('http://localhost:4201/', dev), false);
  assert.equal(allowRequest('https://example.com', dev), false);
});
