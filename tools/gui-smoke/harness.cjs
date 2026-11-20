'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: pause } = require('node:timers/promises');

const { SMOKE_RUN: runDir, SMOKE_MAIN: main, SMOKE_SCENARIO: scenario } = process.env;
if (!runDir || !main || !scenario) throw new Error('Start with run.sh');
const launch = Number(process.env.SMOKE_LAUNCH);
const url = pathToFileURL(path.resolve(path.dirname(main), '../reader-ui/index.html')).href;
const log = (...data) => console.log('[smoke]', ...data);
const RELAUNCH = Symbol('relaunch');
const fixtureDir = path.join(runDir, 'fixtures');
const approved = new Set();
let nextFiles = [];

function checkFixture(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || fs.realpathSync(file) !== file) {
    throw new Error(`Not a plain synthetic fixture: ${file}`);
  }
}

function fixture(name, contents) {
  if (path.basename(name) !== name || !/\.(txt|epub)$/i.test(name)) {
    throw new Error('Fixture must be a local .txt or .epub basename');
  }
  const file = path.join(fixtureDir, name);
  const bytes = Buffer.from(contents);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    checkFixture(file);
    if (!fs.readFileSync(file).equals(bytes)) throw new Error(`Fixture changed: ${file}`);
  }
  approved.add(file);
  return file;
}

function queueImport(...files) {
  for (const file of files) {
    if (!approved.has(file)) throw new Error('Only paths returned by ui.fixture/fixtures may be imported');
    checkFixture(file);
  }
  nextFiles = files;
}

dialog.showOpenDialog = async (parent, options) => {
  if (parent?.webContents?.getURL() !== url || !options?.properties?.includes('openFile')) {
    return { canceled: true, filePaths: [] };
  }
  const files = nextFiles;
  nextFiles = [];
  for (const file of files) checkFixture(file);
  log(`Native import dialog: ${files.length} synthetic file(s)`);
  return { canceled: !files.length, filePaths: files };
};

const title = '冒烟测试样书';
const opening = '这是专供界面冒烟测试的合成文本。';
const book = fixture(`${title}.txt`, [1, 2, 3].map(chapter => [
  `第${chapter}章 合成样例`,
  ...Array.from({ length: 64 }, (_, i) =>
    `${opening}第一处选中锚点。第二处批注锚点。章节 ${chapter} 段落 ${i + 1}。` +
    '一艘纸船沿着想象中的河流前进，穿过一座座纸桥。远处的灯亮了，提醒读者这是虚构的测试段落。'.repeat(3)),
].join('\n')).join('\n\n') + '\n');
const shortBook = fixture('短篇冒烟样书.txt', `第一章 短篇样例\n另一份独立的合成书籍，不含私人内容。\n`);

async function until(probe, timeout, label) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await pause(40);
  } while (Date.now() < deadline);
  throw new Error(`Timed out (${timeout} ms): ${label}`);
}

// Runs unchanged inside the real renderer. Offsets are UTF-16 positions within
// the text of the selected element (for example a [data-content-start] run).
function textEndpoints(mode, ...anchors) {
  function locate({ selector, index = 0, offset }) {
    const el = document.querySelectorAll(selector)[index];
    if (!el || !Number.isInteger(offset) || offset < 0) {
      throw new Error(`Invalid text endpoint: ${selector}[${index}] offset ${offset}`);
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let inner = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.length && inner <= node.length) return { el, node, inner };
      inner -= node.length;
    }
    throw new Error(`No text at ${selector}[${index}] offset ${offset}`);
  }
  const endpoints = anchors.map(locate);
  if (mode === 'dom') {
    const [a, b] = endpoints;
    const sel = window.getSelection();
    sel.setBaseAndExtent(a.node, a.inner, b.node, b.inner);
    return sel.toString();
  }
  return endpoints.map(({ el, node, inner }) => {
    const range = document.createRange();
    range.setStart(node, inner);
    range.collapse(true);
    for (const r of range.getClientRects()) {
      const y = Math.round((r.top + r.bottom) / 2);
      for (const dx of [0, 1, -1, 2, -2, 3, -3]) {
        const x = Math.round(r.left) + dx;
        if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
        if (!el.contains(document.elementFromPoint(x, y))) continue;
        const caret = document.caretRangeFromPoint(x, y);
        if (caret?.startContainer === node && caret.startOffset === inner) return { x, y };
      }
    }
    throw new Error('Cannot hit text caret; ensure both text endpoints are visible or use selectDom');
  });
}

function makeUI(win) {
  const wc = win.webContents;
  const evaluate = (fn, ...args) => wc.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const waitFor = (fn, args = [], timeout = 10_000) =>
    until(() => evaluate(fn, ...args), timeout, fn.toString().slice(0, 160));
  const paint = () => evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  // A compositor without a keyboard seat can report isFocused() === false
  // even when Electron can send input to this WebContents.
  const focus = () => {
    if (!win.isFocused()) win.focus();
    if (!wc.isFocused()) wc.focus();
  };
  const viewportPoint = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Expected CSS coordinates { x, y }');
    const z = wc.getZoomFactor();
    return { x: Math.round(x * z), y: Math.round(y * z) };
  };
  const mouse = (type, { x, y }, more = {}) =>
    wc.sendInputEvent({ type, ...viewportPoint(x, y), ...more });
  const point = (selector, { index = 0, text = null, scroll = true } = {}) =>
    evaluate((css, n, label, shouldScroll) => {
      const squeeze = s => s?.trim().replace(/\s+/g, ' ');
      const el = [...document.querySelectorAll(css)].filter(e => label === null ||
        [e.innerText, e.getAttribute('aria-label'), e.title].some(t => squeeze(t) === squeeze(label)))[n];
      if (!el) throw new Error(`No matching element: ${css} ${JSON.stringify(label)} [${n}]`);
      if (el.closest(':disabled,[aria-disabled="true"]')) throw new Error('Target is disabled');
      if (shouldScroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      for (const r of el.getClientRects()) {
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        if (right <= left || bottom <= top) continue;
        for (const fx of [0.5, 0.25, 0.75]) for (const fy of [0.5, 0.25, 0.75]) {
          const x = Math.floor(left + fx * (right - left));
          const y = Math.floor(top + fy * (bottom - top));
          if (el.contains(document.elementFromPoint(x, y))) return { x, y };
        }
      }
      throw new Error(`Target is obscured or off-screen: ${css} ${JSON.stringify(label)}`);
    }, selector, index, text, scroll);
  const clickAt = async (x, y) => {
    focus();
    const p = { x, y };
    mouse('mouseMove', p);
    mouse('mouseDown', p, { button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] });
    mouse('mouseUp', p, { button: 'left', clickCount: 1 });
    await paint();
  };
  const click = async (selector, opts) => {
    const { x, y } = await point(selector, opts);
    await clickAt(x, y);
  };
  const drag = async (from, to) => {
    focus();
    mouse('mouseMove', from);
    mouse('mouseDown', from, { button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] });
    try {
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        mouse('mouseMove', { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) },
          { button: 'left', modifiers: ['leftButtonDown'] });
        await pause(12);
      }
    } finally {
      mouse('mouseUp', to, { button: 'left', clickCount: 1 });
    }
    await paint();
  };
  const selection = () => evaluate(() => window.getSelection()?.toString() ?? '');
  const screenshot = async name => {
    if (!/^[\w-]+$/.test(name)) throw new Error('Screenshot name must contain only letters, digits, _ or -');
    await paint();
    const image = await wc.capturePage();
    if (image.isEmpty()) throw new Error('Empty screenshot');
    const file = path.join(runDir, 'screenshots', `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    log(`Screenshot: ${file}`);
    return file;
  };
  return {
    launch, runDir, fixtures: { book, shortBook, title, opening }, fixture, queueImport, log,
    eval: evaluate, waitFor, wait: (css, ms) => waitFor(s => !!document.querySelector(s), [css], ms),
    settle: paint, point, clickAt, click, drag, selection, screenshot,
    clickText: (label, { selector = 'button,a,[role="button"],[role="tab"],summary', ...opts } = {}) =>
      click(selector, { ...opts, text: label }),
    caret: async a => (await evaluate(textEndpoints, 'point', a))[0],
    select: async (a, b) => {
      focus();
      await paint(); // The reader may still be restoring its scroll position on a frame.
      const [from, to] = await evaluate(textEndpoints, 'point', a, b);
      await drag(from, to);
      return selection();
    },
    selectDom: (a, b) => evaluate(textEndpoints, 'dom', a, b), // No trusted pointer events.
    press: async (keyCode, modifiers = []) => {
      focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await paint();
    },
    type: async text => { await focus(); await wc.insertText(text); await paint(); },
    relaunch: () => RELAUNCH, // `return ui.relaunch()` to restart with the same profile.
  };
}

let ui;
async function start() {
  const profile = path.join(runDir, 'profile');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  log(`Launch ${launch}: ${main}`);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load', (_e, code, reason, location) =>
      log(`Load error ${code}: ${reason} (${location})`));
    contents.on('render-process-gone', (_e, details) => log('Renderer gone:', details));
    contents.on('console-message', (_e, details) => {
      if (details?.level === 'error') log('Renderer:', details.message);
    });
  });
  require(main); // Use its original __dirname; do not copy or patch the app.
  await app.whenReady();
  let win;
  try {
    win = await until(() => BrowserWindow.getAllWindows().find(w =>
      !w.webContents.isLoadingMainFrame() && w.webContents.getURL() === url),
    15_000, `production window at ${url}`);
    // With a hidden initial window, headless Wayland may not deliver the frame
    // that triggers Electron's ready-to-show. Map the same window if needed.
    if (!win.isVisible()) await pause(500);
    if (!win.isVisible()) {
      log('Showing the loaded production window (headless Wayland)');
      win.show();
    }
  } catch (err) {
    log('Windows:', JSON.stringify(BrowserWindow.getAllWindows().map(w => ({
      id: w.id, visible: w.isVisible(), loading: w.webContents.isLoadingMainFrame(),
      url: w.webContents.getURL(),
    }))));
    throw err;
  }
  ui = makeUI(win);
  const rendererPid = win.webContents.getOSProcessId();
  const status = fs.readFileSync(`/proc/${rendererPid}/status`, 'utf8');
  const sandbox = status.match(/^(NoNewPrivs|Seccomp):\s*\d+$/gm)?.join(', ').replaceAll('\t', ' ');
  log(`Electron ${process.versions.electron} window: ${url} (renderer PID ${rendererPid}; ${sandbox})`);
  if (!/^NoNewPrivs:\s*1$/m.test(status) || !/^Seccomp:\s*2$/m.test(status)) {
    throw new Error('Renderer sandbox check failed');
  }
  const result = await require(scenario)(ui);
  fs.writeFileSync(path.join(runDir, 'result'), result === RELAUNCH ? 'relaunch\n' : 'done\n', { flag: 'wx' });
  app.quit();
}

start().catch(async error => {
  log(`Failure: ${error.stack ?? error}`);
  try { if (ui) await ui.screenshot(`error-${launch}`); } catch { /* preserve the original error */ }
  app.exit(1);
});
