'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const queues = new Map();
const REVISION = /^revision-(\d{16})\.json$/;
const SNAPSHOT = /^snapshot-(\d{16})-([a-f0-9]{64})\.json$/;

class StorageError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}
function fail(code, message, details, cause) {
  throw new StorageError(code, message, details, cause);
}
function comparablePath(value) {
  if (process.platform !== 'win32') return value;
  return (value.startsWith('\\\\?\\') ? value.slice(4) : value).toLowerCase();
}
function validateId(id) {
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)
  ) {
    fail(
      'INVALID_ID',
      'Use a portable ID of 1–80 letters, digits, underscores or hyphens.',
    );
  }
  if (id !== id.toLowerCase())
    fail(
      'INVALID_ID',
      'Record IDs must use lowercase ASCII to remain portable across filesystems.',
    );
  return id;
}
function jsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    seen.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail('INVALID_DATA', 'Data must be lossless JSON.');
  }
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length)
    fail('INVALID_DATA', 'Symbol keys are not JSON.');
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i))
        fail('INVALID_DATA', 'Sparse arrays are not JSON.');
      jsonData(value[i], seen);
    }
    if (Object.keys(value).length !== value.length)
      fail('INVALID_DATA', 'Array properties are not JSON.');
  } else {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value'))
        fail('INVALID_DATA', 'Accessors are not JSON.');
      jsonData(descriptor.value, seen);
    }
  }
  seen.delete(value);
}
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const revisionName = (revision) =>
  `revision-${String(revision).padStart(16, '0')}.json`;

/** Main-process only. Root must be private to the application and owned by one Electron instance.
 * Files are immutable; no automatic pruning or fallback ever discards confirmed revisions.
 * checkpoint is an optional test/fault-injection hook, never supplied by a renderer.
 */
class DurableStore {
  constructor({
    root,
    schemaVersion,
    schemas,
    migrations = {},
    checkpoint = async () => {},
  }) {
    if (typeof root !== 'string' || !path.isAbsolute(root))
      fail('INVALID_ROOT', 'Use an absolute private data root.');
    if (
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      typeof schemas?.[schemaVersion] !== 'function'
    ) {
      fail(
        'INVALID_SCHEMA',
        'Provide a positive schemaVersion and a validator for that version.',
      );
    }
    this.root = path.resolve(root);
    this.schemaVersion = schemaVersion;
    this.schemas = schemas;
    this.migrations = migrations;
    this.checkpoint = checkpoint;
  }
  _queue(id, operation) {
    validateId(id);
    // Windows filesystems are usually case-insensitive; validateId enforces lowercase IDs.
    const key = path.join(this.root, id.toLowerCase());
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.then(operation);
    const settled = result.catch(() => {});
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return result;
  }
  async _sync(directory) {
    // Node cannot flush a directory handle on Windows. File contents are flushed
    // before publication and NTFS atomic link publication is used; Windows power
    // loss durability remains an explicit platform acceptance item (S00-A3/A5).
    if (process.platform === 'win32') return;
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async _directory(id) {
    // mkdir one level at a time, flushing each parent; reject symlink components.
    const directory = path.join(this.root, id);
    const parts = directory
      .slice(path.parse(directory).root.length)
      .split(path.sep);
    let current = path.parse(directory).root;
    for (const part of parts) {
      const parent = current;
      current = path.join(current, part);
      try {
        await fs.mkdir(current, { mode: 0o700 });
        await this._sync(parent);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail('UNSAFE_PATH', 'Storage directories must not be symlinks.');
    }
    return directory;
  }
  _validate(version, data) {
    jsonData(data);
    if (typeof this.schemas[version] !== 'function')
      fail('UNSUPPORTED_SCHEMA', `No validator for schema ${version}.`);
    let valid;
    try {
      valid = this.schemas[version](clone(data));
    } catch (error) {
      fail('INVALID_SCHEMA', `Schema ${version} validation failed.`, {}, error);
    }
    if (valid !== true)
      fail('INVALID_SCHEMA', `Schema ${version} validation failed.`);
  }
  _encode(id, revision, schemaVersion, data) {
    this._validate(schemaVersion, data);
    const payload = { id, revision, schemaVersion, data };
    return JSON.stringify({
      ...payload,
      checksum: hash(JSON.stringify(payload)),
    });
  }
  async _read(directory, name, id) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail('UNSAFE_PATH', 'Storage files must be regular files.');
    const text = await fs.readFile(file, 'utf8');
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      fail(
        'CORRUPT',
        'Invalid JSON; select a validated recovery candidate.',
        { name },
        error,
      );
    }
    if (
      !value ||
      value.id !== id ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !Number.isSafeInteger(value.schemaVersion) ||
      value.schemaVersion < 1 ||
      Object.keys(value).sort().join(',') !==
        'checksum,data,id,revision,schemaVersion'
    ) {
      fail('CORRUPT', 'Invalid storage envelope.', { name });
    }
    const { revision, schemaVersion, data } = value;
    if (id !== id.toLowerCase())
      fail('CORRUPT', 'Record ID is not canonical lowercase.', { name });
    if (
      value.checksum !==
      hash(JSON.stringify({ id, revision, schemaVersion, data }))
    )
      fail('CORRUPT', 'Checksum mismatch.', { name });
    const match = REVISION.exec(name) || SNAPSHOT.exec(name);
    if (
      !match ||
      Number(match[1]) !== revision ||
      (match[2] && match[2] !== hash(text))
    )
      fail('CORRUPT', 'Filename does not match content.', { name });
    this._validate(schemaVersion, data);
    return { value: { id, revision, schemaVersion, data }, text };
  }
  async _head(directory, id) {
    const names = (await fs.readdir(directory))
      .filter((name) => REVISION.test(name))
      .sort();
    if (!names.length) return { revision: 0, record: null };
    const name = names.at(-1);
    const revision = Number(REVISION.exec(name)[1]);
    try {
      return { revision, record: await this._read(directory, name, id) };
    } catch (error) {
      fail(
        'RECOVERY_REQUIRED',
        'Latest revision is unreadable. List and explicitly select a validated recovery candidate.',
        { revision, name },
        error,
      );
    }
  }
  async _publish(directory, name, text) {
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await this.checkpoint('before-file-sync', { name });
      await handle.sync();
      await handle.close();
      handle = null;
      await this.checkpoint('after-file-sync', { name });
      // Hard-link publication is atomic and refuses to replace an existing revision.
      await fs.link(temporary, path.join(directory, name));
      await this.checkpoint('after-publish', { name });
      await this._sync(directory);
      await this.checkpoint('after-directory-sync', { name });
    } catch (error) {
      fail(
        'IO_ERROR',
        'Persistence was not acknowledged. Reload before retrying; the revision may have committed.',
        { name },
        error,
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
  _next(revision) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      fail('REVISION_LIMIT', 'Revision cannot be incremented.');
    return revision + 1;
  }
  async _snapshot(directory, record) {
    const name = `snapshot-${String(record.value.revision).padStart(16, '0')}-${hash(record.text)}.json`;
    try {
      await this._publish(directory, name, record.text);
    } catch (error) {
      if (error.cause?.code !== 'EEXIST') throw error;
      const existing = await this._read(directory, name, record.value.id);
      if (existing.text !== record.text) throw error;
      await this._sync(directory);
    }
    await this.checkpoint('after-snapshot', { name });
    return name;
  }
  load(id) {
    return this._queue(id, async () => {
      const directory = await this._directory(id);
      const { record } = await this._head(directory, id);
      return record ? clone(record.value) : null;
    });
  }
  save(id, data, expectedRevision) {
    // Capture caller data now, before queued work can observe later mutation.
    let captured;
    try {
      validateId(id);
      this._validate(this.schemaVersion, data);
      captured = clone(data);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._queue(id, async () => {
      const directory = await this._directory(id);
      const head = await this._head(directory, id);
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision !== head.revision
      )
        fail('STALE_REVISION', 'Reload and merge before saving.', {
          actualRevision: head.revision,
        });
      if (head.record && head.record.value.schemaVersion !== this.schemaVersion)
        fail(
          'MIGRATION_REQUIRED',
          'Migrate before saving with the current schema.',
        );
      const revision = this._next(head.revision);
      const text = this._encode(id, revision, this.schemaVersion, captured);
      await this._publish(directory, revisionName(revision), text);
      return JSON.parse(text);
    });
  }
  remove(id) {
    return this._queue(id, async () => {
      const directory = path.join(this.root, id);
      const realRoot = await fs.realpath(this.root).catch(() => '');
      if (
        !realRoot ||
        comparablePath(path.dirname(path.resolve(directory))) !==
          comparablePath(realRoot)
      )
        fail('UNSAFE_PATH', 'Storage record path is invalid.');
      await fs.rm(directory, { recursive: true, force: true });
    });
  }
  migrate(id) {
    return this._queue(id, async () => {
      const directory = await this._directory(id);
      const { record, revision } = await this._head(directory, id);
      if (!record) return null;
      let { schemaVersion, data } = record.value;
      if (schemaVersion > this.schemaVersion)
        fail(
          'UNSUPPORTED_SCHEMA',
          'This data was written by a newer application.',
        );
      if (schemaVersion === this.schemaVersion) return clone(record.value);
      const snapshot = await this._snapshot(directory, record);
      try {
        while (schemaVersion < this.schemaVersion) {
          if (typeof this.migrations[schemaVersion] !== 'function')
            fail(
              'MISSING_MIGRATION',
              `No migration from schema ${schemaVersion}.`,
            );
          data = await this.migrations[schemaVersion](clone(data));
          this._validate(++schemaVersion, data);
          await this.checkpoint('after-migration-step', { schemaVersion });
        }
        const text = this._encode(
          id,
          this._next(revision),
          schemaVersion,
          data,
        );
        await this._publish(directory, revisionName(revision + 1), text);
        return JSON.parse(text);
      } catch (error) {
        // No in-place mutation: prior revision and snapshot remain rollback sources.
        fail(
          'MIGRATION_FAILED',
          'Migration was not acknowledged. Reload or select the pre-migration snapshot.',
          { snapshot },
          error,
        );
      }
    });
  }
  listRecovery(id) {
    return this._queue(id, async () => {
      const directory = await this._directory(id);
      const results = [];
      for (const name of (await fs.readdir(directory)).sort()) {
        if (!REVISION.test(name) && !SNAPSHOT.test(name)) continue;
        try {
          const { value, text } = await this._read(directory, name, id);
          results.push({
            name,
            valid: true,
            revision: value.revision,
            schemaVersion: value.schemaVersion,
            checksum: hash(text),
          });
        } catch (error) {
          const match = REVISION.exec(name) || SNAPSHOT.exec(name);
          results.push({
            name,
            valid: false,
            revision: Number(match[1]),
            error: error.code || 'IO_ERROR',
          });
        }
      }
      return results;
    });
  }
  recover(id, selection) {
    return this._queue(id, async () => {
      if (
        !selection ||
        (!REVISION.test(selection.name) && !SNAPSHOT.test(selection.name)) ||
        !/^[a-f0-9]{64}$/.test(selection.checksum) ||
        !Number.isSafeInteger(selection.expectedRevision)
      ) {
        fail(
          'INVALID_SELECTION',
          'Select a candidate name and checksum from listRecovery, with the current highest revision.',
        );
      }
      const directory = await this._directory(id);
      const names = (await fs.readdir(directory))
        .filter((name) => REVISION.test(name))
        .sort();
      const highest = names.length ? Number(REVISION.exec(names.at(-1))[1]) : 0;
      if (selection.expectedRevision !== highest)
        fail('STALE_REVISION', 'Recovery selection is stale.', {
          actualRevision: highest,
        });
      const { value, text } = await this._read(directory, selection.name, id);
      if (hash(text) !== selection.checksum)
        fail('INVALID_SELECTION', 'Candidate changed since validation.');
      // Preserve every original, including corrupt files, and restore as a new monotonic revision.
      const revision = this._next(highest);
      const restored = this._encode(
        id,
        revision,
        value.schemaVersion,
        value.data,
      );
      await this._publish(directory, revisionName(revision), restored);
      return JSON.parse(restored);
    });
  }
}

module.exports = { DurableStore, StorageError, validateId };
