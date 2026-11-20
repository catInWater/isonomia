import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validReadingRequest } from '../library/reading.cjs';
import { validAnnotationRequest } from '../library/annotations.cjs';

/** Only the shell's own top-level document may invoke privileged methods. */
export function isTrustedSender(
  frameUrl: string,
  isMainFrame: boolean,
  documentUrl: string,
): boolean {
  if (!isMainFrame) return false;
  try {
    const actual = new URL(frameUrl);
    const expected = new URL(documentUrl);
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch {
    return false;
  }
}

export function rendererDocument(directory: string, port?: number): string {
  return port
    ? `http://localhost:${port}/`
    : pathToFileURL(resolve(directory, '../reader-ui/index.html')).href;
}

/** No renderer supplied file paths, URLs, commands or raw IPC channels. */
export function validateRequest(method: string, args: unknown[]): void {
  const valid =
    (['openBook', 'readChapter', 'saveReading'].includes(method) &&
      args.length === 1 &&
      validJson(args[0]) &&
      withinJsonLimit(args[0]) &&
      validReadingRequest(method, args[0])) ||
    (['listAnnotations', 'changeAnnotation', 'copyAnnotation'].includes(
      method,
    ) &&
      args.length === 1 &&
      validJson(args[0]) &&
      withinJsonLimit(args[0]) &&
      validAnnotationRequest(method, args[0])) ||
    ((method === 'version' ||
      method === 'storageStatus' ||
      method === 'libraryList' ||
      method === 'libraryImport') &&
      args.length === 0) ||
    (method === 'libraryCover' && args.length === 1 && validBookId(args[0])) ||
    (method === 'libraryRemove' &&
      args.length === 2 &&
      validBookId(args[0]) &&
      typeof args[1] === 'boolean') ||
    ((method === 'libraryOpen' || method === 'libraryReplace') &&
      args.length === 1 &&
      validBookId(args[0])) ||
    (method === 'load' && args.length === 1 && validRecordId(args[0])) ||
    (method === 'save' &&
      args.length === 3 &&
      validRecordId(args[0]) &&
      Number.isSafeInteger(args[2]) &&
      (args[2] as number) >= 0 &&
      validJson(args[1]) &&
      withinJsonLimit(args[1])) ||
    (method === 'listRecovery' &&
      args.length === 1 &&
      validRecordId(args[0])) ||
    (method === 'recover' &&
      args.length === 2 &&
      validRecordId(args[0]) &&
      validRecoverySelection(args[1]));
  if (!valid) throw new Error('请求无效或数据格式不支持。请检查内容后重试。');
}

export function validBookId(value: unknown): value is string {
  return typeof value === 'string' && /^book-[a-z0-9]{32}$/.test(value);
}

export function validRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:book|note)-[a-z0-9_-]{1,74}$|^settings$/.test(value)
  );
}

export function validRecoverySelection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (
    Object.getOwnPropertySymbols(selection).length ||
    Object.values(Object.getOwnPropertyDescriptors(selection)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )
  )
    return false;
  return (
    Object.keys(selection).sort().join(',') ===
      'checksum,expectedRevision,name' &&
    typeof selection.name === 'string' &&
    /^(?:snapshot-\d{16}-[a-f0-9]{64}|revision-\d{16})\.json$/.test(
      selection.name,
    ) &&
    typeof selection.checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(selection.checksum) &&
    Number.isSafeInteger(selection.expectedRevision) &&
    (selection.expectedRevision as number) >= 0
  );
}

export function validJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (
    typeof value !== 'object' ||
    depth > 40 ||
    seen.has(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null &&
      !Array.isArray(value)) ||
    Object.getOwnPropertySymbols(value).length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )
  )
    return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.length <= 100_000 &&
      value.every((item) => validJson(item, seen, depth + 1))
    : Object.entries(value).every(
        ([key, item]) =>
          key !== '__proto__' && validJson(item, seen, depth + 1),
      );
  seen.delete(value);
  return valid;
}

function withinJsonLimit(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= 1_000_000;
  } catch {
    return false;
  }
}

export function allowRequest(url: string, documentUrl: string): boolean {
  if (
    url.length <= 2_800_000 &&
    /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url)
  )
    return true;
  try {
    const request = new URL(url);
    const document = new URL(documentUrl);
    if (document.protocol === 'http:') {
      return (
        document.hostname === 'localhost' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(request.hostname) &&
        ['http:', 'ws:'].includes(request.protocol) &&
        request.port === document.port
      );
    }
    // Production shell only needs bundled assets beneath its own directory.
    const base = new URL('.', document);
    return (
      request.protocol === 'file:' &&
      request.host === base.host &&
      !/%2f|%5c/i.test(request.pathname) &&
      decodeURIComponent(request.pathname).startsWith(
        decodeURIComponent(base.pathname),
      )
    );
  } catch {
    return false;
  }
}
