'use strict';
const assert = require('node:assert/strict');
const { BrowserWindow, clipboard } = require('electron');

const title = '阶段三合成样书';
const first = '萤火观察记录';
const second = '远山采访记录';
const note = '想法一：这是一条测试批注。';
const revised = '修改后的批注：重启时仍可阅读。';
const heading = '第一章 紙船';
const blocks = [
  '這是合成測試文檔的開頭，沒有私人的書籍或資料。',
  `清晨村外出发：${first}，还有一份${second}。最后沿河回到家。`,
  ...Array.from({ length: 54 }, (_, i) =>
    `第${i + 1}段观察样例。` + '纸船沿着想象中的河流前进，穿过一座座纸桥。远处的灯亮了，照在河面上。'.repeat(3)),
];
const source = `${heading}\n${blocks.join('\n')}\n\n第二章 灯塔\n这里是另一个章节的起始段落。\n`;
const css = {
  quote: 'section[aria-label="本书划线与批注"] blockquote',
  panel: 'section[aria-label="本书划线与批注"]',
  note: 'textarea[name="annotation"]',
  body: 'article[aria-label="正文"]',
  shelf: 'article button h2',
};

module.exports = async (ui) => {
  const file = ui.fixture(`${title}.txt`, source);
  const replacement = ui.fixture('替换正文.txt', `${heading}\n新版序言。\n沿新路出门，${first}现在在这里。\n第二章 灯塔\n这个章节不再包含旧的采访记录。\n`);
  const available = (label, selector = 'button') => ui.waitFor((text, sel) =>
    [...document.querySelectorAll(sel)].some(e => e.innerText.trim() === text && !e.disabled), [label, selector]);
  const button = async (label, selector = 'button') => {
    await available(label, selector);
    const marker = await ui.eval((s, label) => {
      const e = Array.from(document.querySelectorAll(s)).find(e => e.innerText.trim() === label && !e.disabled);
      if (!e) return false;
      e.dataset.smokeHit = 'button';
      return true;
    }, selector, label);
    assert.ok(marker);
    try {
      await ui.click('[data-smoke-hit="button"]');
    } finally {
      await ui.eval(() => document.querySelector('[data-smoke-hit="button"]')?.removeAttribute('data-smoke-hit'));
    }
  };
  const text = (selector, value) => ui.waitFor((s, v) => document.querySelector(s)?.innerText.trim() === v, [selector, value]);
  const detail = (value) => text(css.quote, value);
  const shelf = () => text('h1', '书架');
  const book = async () => {
    await text(css.shelf, title);
    await ui.clickText(title, { selector: css.shelf });
    await ui.wait(css.body);
    await available('全书划线');
  };
  const list = async () => {
    if (await ui.eval((s) => Boolean(document.querySelector(s)), css.panel)) await button('关闭');
    await button('全书划线');
  };
  const row = async (quote) => {
    await ui.waitFor((p, value) => [...document.querySelectorAll(`${p} li button span`)].some(e => e.textContent === value), [css.panel, quote]);
    await ui.eval((p, value) => [...document.querySelectorAll(`${p} li button`)].find(e => e.firstElementChild?.textContent === value)?.setAttribute('data-smoke-row',''), css.panel, quote);
    try { await ui.click('[data-smoke-row]'); }
    finally { await ui.eval(() => document.querySelector('[data-smoke-row]')?.removeAttribute('data-smoke-row')); }
    await detail(quote);
  };
  const choose = async (option, key) => {
    await ui.eval((p) => document.querySelector(`${p} select`).focus(), css.panel);
    await ui.press(key);
    await ui.press('Enter');
    if (!(await ui.eval((p, value) => document.querySelector(`${p} select`)?.value === value, css.panel, option))) {
      // Chromium's native select menu has no Wayland input seat on this compositor.
      await ui.eval((p, value) => {
        const select = document.querySelector(`${p} select`);
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, css.panel, option);
    }
    await ui.waitFor((p, value) => document.querySelector(`${p} select`)?.value === value, [css.panel, option]);
  };
  const selectQuote = async (quote) => {
    const selector = `${css.body} [data-block-index="1"]`;
    const offset = blocks[1].indexOf(quote);
    assert.ok(offset >= 0);
    assert.equal(await ui.select({ selector, offset }, { selector, offset: offset + quote.length }), quote);
  };
  const persisted = (value) => ui.waitFor((s, v) => document.querySelector(s)?.value === v, [css.note, value]);
  const hasMark = (quote, color) => ui.waitFor((p, q, c) => [...document.querySelectorAll(`${p} [data-highlight-color]`)].some(el => el.textContent === q && el.dataset.highlightColor === c), [css.body, quote, color]);
  const emphasize = (quote) => ui.waitFor((p, q) => [...document.querySelectorAll(`${p} [data-emphasis="jump"]`)].some(el => el.textContent.includes(q)), [css.body, quote], 5000);

  await shelf();
  if (ui.launch === 1) {
    ui.queueImport(file);
    await button('导入书籍');
    await book();
    await selectQuote(first);
    await button('划线');
    await hasMark(first, 'yellow');
    await selectQuote(second);
    await button('写批注');
    await detail(second);
    await choose('green', 'Down');
    await ui.click(css.note);
    await ui.type(note);
    await button('保存批注', `${css.panel} button`);
    await hasMark(second, 'green');
    await persisted(note);
    await ui.screenshot('01-highlight-and-note');

    await button('关闭');
    await ui.clickText(second, { selector: `${css.body} [data-highlight-id]` });
    await persisted(note);
    await choose('blue', 'End');
    await ui.click(css.note);
    await ui.press('A', ['control']);
    await ui.type(revised);
    await button('保存批注', `${css.panel} button`);
    await hasMark(second, 'blue');
    await persisted(revised);
    await button('删除划线');
    await available('撤销删除');
    assert.equal(await ui.eval((s, quote) => [...document.querySelectorAll(`${s} [data-highlight-id]`)].some(e => e.textContent === quote), css.body, second), false);
    await button('撤销删除');
    await persisted(revised);
    await hasMark(second, 'blue');

    await button('关闭');
    await ui.click('#reader-toc button', { index: 1 });
    await text('h1', '第二章 灯塔');
    await list();
    assert.deepEqual(await ui.eval((s) => [...document.querySelectorAll(`${s} li button span`)].map(e => e.textContent), css.panel), [first, second]);
    await choose('time', 'End');
    await ui.waitFor((s, q) => document.querySelector(`${s} li button span`)?.textContent === q, [css.panel, second]);
    await row(first);
    await text('h1', heading);
    await emphasize(first);
    await button('关闭');
    await ui.log('Verified drag-to-highlight, create/edit, two-way jump, sort, delete and undo');

    await button('分页');
    await ui.waitFor((s) => document.querySelector(s)?.hasAttribute('aria-live'), [css.body]);
    const onPage = (p) => ui.waitFor((page) => [...document.querySelectorAll('span')].some(e => e.innerText.match(new RegExp(`^第 ${page} / \\d+ 页$`))), [p]);
    await onPage(1);
    const startSelector = `${css.body} [data-block-index="2"] [data-content-start]`;
    await ui.wait(startSelector);
    const start = await ui.eval((s) => ({ block: Number(document.querySelector(s).closest('[data-block-index]').dataset.blockIndex), from: Number(document.querySelector(s).dataset.contentStart) + 4 }), startSelector);
    assert.equal(await ui.select({ selector: startSelector, offset: 4 }, { selector: startSelector, offset: 11 }), blocks[start.block].slice(start.from, start.from + 7));
    await button('跨页选取');
    await onPage(2);
    await ui.waitFor((s) => [...document.querySelectorAll(`${s} [data-content-start]`)].some(e => e.textContent.length > 35), [css.body]);
    const end = await ui.eval((s) => {
      const runs = [...document.querySelectorAll(`${s} [data-content-start]`)];
      const e = runs.find(r => r.textContent.length > 35 && r.getBoundingClientRect().top > 350 && r.getBoundingClientRect().top < 570);
      if (!e) throw new Error('No visible endpoint on the second page');
      const block = Number(e.closest('[data-block-index]').dataset.blockIndex);
      const selector = `${s} [data-block-index="${block}"] [data-content-start="${e.dataset.contentStart}"]`;
      return { selector, block, offset: Number(e.dataset.contentStart) + 18 };
    }, css.body);
    assert.equal(await ui.select({ selector: end.selector, offset: 10 }, { selector: end.selector, offset: 18 }), blocks[end.block].slice(end.offset - 8, end.offset));
    const excerpt = [blocks[start.block].slice(start.from), ...blocks.slice(start.block + 1, end.block), blocks[end.block].slice(0, end.offset)].join('\n');
    await button('划线', 'div[aria-label="选区操作"] button');
    await ui.waitFor((s) => !!document.querySelector(`${s} [data-highlight-id]`), [css.body]);
    await ui.screenshot('02-cross-page-second-page');
    await list();
    await row(excerpt);
    await onPage(1);
    await ui.waitFor((s) => !!document.querySelector(`${s} [data-block-index="2"] [data-highlight-id]`), [css.body]);
    await ui.screenshot('03-cross-page-jump');
    await ui.waitFor(() => ![...document.querySelectorAll('[role="status"]')].some(e => e.innerText === '保存中…'));
    ui.log(`Verified same-chapter cross-page excerpt (${excerpt.length} UTF-16 units)`);
    return ui.relaunch();
  }

  await book();
  await list();
  await row(second);
  await persisted(revised);
  await hasMark(second, 'blue');
  await button('深色主题'.replace('深色主题', '☾'));
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setZoomFactor(2.1);
  await ui.waitFor(() => innerWidth <= 640);
  assert.ok(await ui.eval(() => document.documentElement.scrollWidth <= innerWidth));
  await ui.screenshot('04-narrow-dark-restarted');
  win.webContents.setZoomFactor(1);
  await ui.waitFor(() => innerWidth >= 1000);
  await ui.clickText('← 书架');
  await shelf();
  await button('划线与批注');
  ui.queueImport(replacement);
  await button('替换正文…');
  await ui.waitFor(() => document.body.innerText.includes('正文已替换'));
  await book();
  await list();
  await row(first);
  await text(`${css.panel} h2`, '划线与批注');
  await ui.waitFor((s) => document.querySelector(s)?.innerText.includes('已按原文片段重新定位'), [css.panel]);
  await hasMark(first, 'yellow');
  await button('返回列表');
  await row(second);
  await ui.waitFor((s) => document.querySelector(s)?.innerText.includes('未找到原文'), [css.panel]);
  await persisted(revised);
  await button('复制原文与批注');
  assert.equal(clipboard.readText(), `原文：${second}\n出处：${title} · 未知作者 · ${heading}\n批注：${revised}`);
  await ui.screenshot('05-replacement-lost-with-note');
  await ui.clickText('← 书架');
  await shelf();
  await button('删除');
  await button('仅移除书文件，保留笔记和批注');
  await row(second);
  await ui.waitFor((s) => document.querySelector(s)?.innerText.includes('原书不可用'), [css.panel]);
  await persisted(revised);
  await ui.screenshot('06-retained-after-removal');
  ui.log('Verified restart, dark/narrow layout, replacement fallback and lost, clipboard citation, retained notes');
};
