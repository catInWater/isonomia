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
  for (const method of ['quit', 'readFile', '__proto__']) {
    assert.throws(() => validateRequest(method, []));
  }
  assert.throws(() => validateRequest('version', ['../../private']));
  assert.throws(() => validateRequest('load', ['reading-book-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']));
});
test('S00-A6 production allows only bundled assets and blocks remote/local escapes', () => {
  assert.equal(allowRequest('file:///opt/reader-ui/main.js', document), true);
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
