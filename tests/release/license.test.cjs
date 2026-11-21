'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');

test('project and app manifests identify AGPL-3.0-or-later', () => {
  for (const relativePath of [
    'package.json',
    'apps/reader/package.json',
    'apps/reader-ui/package.json',
  ]) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, relativePath), 'utf8'),
    );
    assert.equal(manifest.license, 'AGPL-3.0-or-later', relativePath);
  }
  const lockfile = JSON.parse(
    fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  );
  assert.equal(lockfile.packages[''].license, 'AGPL-3.0-or-later');
});

test('renderer bundles the exact canonical project license text', () => {
  const license = fs.readFileSync(path.join(root, 'LICENSE'));
  const rendererLicense = fs.readFileSync(
    path.join(root, 'apps/reader-ui/src/assets/AGPL-3.0-or-later.txt'),
  );
  assert.deepEqual(rendererLicense, license);
  assert.match(
    license.toString('utf8'),
    /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/,
  );
});
