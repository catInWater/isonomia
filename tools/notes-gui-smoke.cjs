'use strict';
// Production Electron smoke: synthetic books + private profile only. No bridge mocks.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { zip } = require('./fixtures.cjs');
const root = process.env.NOTES_SMOKE_DIR;
if (!root || !path.isAbsolute(root))
  throw new Error('Set NOTES_SMOKE_DIR to a fresh absolute test directory.');
const stage = process.env.NOTES_SMOKE_STAGE || 'initial';
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
const sourceA = path.join(root, 'synthetic-notes-a.epub');
const sourceB = path.join(root, 'synthetic-notes-b.txt');
if (stage === 'initial') {
  const paragraphs = [
    '<p>阶段四原文片段用于稳定回跳。<a href="#foot"><sup>[1]</sup></a></p>',
    '<p>另一段原文用于拖放引用测试。</p>',
    ...Array.from(
      { length: 35 },
      (_, i) => `<p>合成段落${i}，用于检查分栏调整不会改变阅读位置。</p>`,
    ),
    '<p>引用起点 <a href="#foot"><sup>[1]</sup></a>继续阅读。</p>',
    '<p id="foot">引用目标内容应该在气泡显示，而不是跳走。</p>',
  ];
  fs.writeFileSync(
    sourceA,
    zip([
      ['mimetype', 'application/epub+zip'],
      [
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
      ],
      [
        'OEBPS/book.opf',
        '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>synthetic-notes-a</dc:title><dc:creator>Smoke fixture</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/><itemref idref="chapter2"/></spine></package>',
      ],
      [
        'OEBPS/chapter.xhtml',
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 合成摘录</title></head><body><h1>第一章 合成摘录</h1>${paragraphs.join('')}</body></html>`,
      ],
      [
        'OEBPS/chapter2.xhtml',
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章 转场测试</title></head><body><h1>第二章 转场测试</h1><p>用于验证跨章后清理旧批注气泡。</p></body></html>',
      ],
    ]),
  );
  fs.writeFileSync(sourceB, '第一章 独立书籍\n第二本书的正文与第一本不同。');
}
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [sourceA, sourceB],
});
dialog.showSaveDialog = async () => ({
  canceled: false,
  filePath: path.join(root, 'unsaved-note-copy.json'),
});
const deadline = setTimeout(() => {
  console.error('NOTES_GUI_TIMEOUT', stage);
  app.exit(1);
}, 90000);
app.on('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', async () => {
    try {
      const testWindow = BrowserWindow.fromWebContents(contents);
      testWindow.show();
      const js = (code) => contents.executeJavaScript(code, true);
      const wait = async (condition, label = condition) => {
        for (let i = 0; i < 150; i++) {
          if (await js(condition)) return;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error(
          `UI timeout: ${label}; ${await js('document.body.innerText.slice(-2200)')}`,
        );
      };
      const click = async (text, scope = 'document') =>
        js(
          `(() => { const b = [...${scope}.querySelectorAll('button')].find(b => (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)} || b.title === ${JSON.stringify(text)}) && !b.disabled); if (!b) throw Error('Button unavailable: ' + ${JSON.stringify(text)}); b.click(); })()`,
        );
      const noteScope = `document.querySelector('[aria-label="笔记"]')`;
      const saved = () =>
        wait(
          `document.querySelector('[aria-label="笔记"] [role="status"]')?.textContent === '已保存'`,
          'notes acknowledged',
        );
      const type = async (text) => {
        await js(`document.querySelector('[aria-label="笔记正文"]').focus()`);
        await contents.insertText(text);
      };
      const select = async (text) => {
        await js(
          `(() => {const article = document.querySelector('article'); const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT); let node; while ((node=walker.nextNode())) { const i=node.textContent.indexOf(${JSON.stringify(text)}); if(i<0)continue; const r=document.createRange(); r.setStart(node,i); r.setEnd(node,i+${text.length}); const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));return;}throw Error('Synthetic selection not found');})()`,
        );
        await wait(
          `[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='插入选区到笔记')`,
        );
      };
      const shot = async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const image = await contents.capturePage();
        const size = image.getSize();
        assert.ok(
          size.width > 300 && size.height > 200,
          'nonempty real screenshot',
        );
        fs.writeFileSync(path.join(root, `${name}.png`), image.toPNG());
        console.log('SCREENSHOT', name, size);
      };
      await wait(
        `Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='导入书籍'))`,
        'shelf ready',
      );
      if (stage === 'initial') {
        await click('关于与许可');
        await wait(
          `document.querySelector('[aria-label="许可证信息"]')?.textContent.includes('AGPL-3.0-or-later')`,
          'license notice is accessible from the shelf',
        );
        const legalNotice = await js(
          `document.querySelector('[aria-label="许可证信息"]').textContent`,
        );
        assert.match(legalNotice, /复制、分发和修改/);
        assert.match(legalNotice, /不提供任何明示或默示担保/);
        await js(
          `document.querySelector('[aria-label="许可证信息"] details').open=true`,
        );
        await wait(
          `document.querySelector('[aria-label="许可证信息"] pre')?.textContent.includes('GNU AFFERO GENERAL PUBLIC LICENSE')`,
          'full AGPL license text is available in the application',
        );
        await shot('00-license-notice');
        await click('关闭关于与许可');
        await click('导入书籍');
        await wait(
          `document.body.innerText.includes('synthetic-notes-a') && document.body.innerText.includes('synthetic-notes-b')`,
        );
        await js(
          `([...document.querySelectorAll('h2')].find(e=>e.textContent==='synthetic-notes-a')).closest('button').click()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="笔记正文"][contenteditable="true"]'))`,
        );
        assert.equal(
          await js(
            `innerWidth===document.documentElement.clientWidth && document.documentElement.scrollWidth<=innerWidth`,
          ),
          true,
          'reader has no horizontal white gutter or page scrollbar',
        );
        assert.equal(
          await js(
            `document.querySelector('[role="toolbar"][aria-label="阅读控制台"]').getBoundingClientRect().height < 40 && getComputedStyle(document.querySelector('[role="toolbar"][aria-label="阅读控制台"]')).flexWrap === 'nowrap'`,
          ),
          true,
          'reader console stays on one line',
        );
        contents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 });
        await wait(
          `document.querySelector('[role="toolbar"][aria-label="阅读控制台"]').getBoundingClientRect().bottom < 10`,
          'console hides after pointer leaves top edge',
        );
        assert.equal(
          await js(
            `getComputedStyle(document.querySelector('[aria-label="正文"]').parentElement).fontFamily.includes('Times New Roman') && !document.querySelector('select[aria-label="字体"]')`,
          ),
          true,
          'font is fixed to the requested bilingual serif stack with no chooser',
        );
        await js(
          `getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`,
        );
        const ratioBeforeToc = await js(
          `(() => { const a=document.querySelector('[aria-label="正文"]').parentElement.getBoundingClientRect().width; const b=document.querySelector('[aria-label="本书笔记"]').getBoundingClientRect().width; return b/(a+b); })()`,
        );
        contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 160 });
        await wait(
          `document.querySelector('[aria-label="目录"]').dataset.open==='true'`,
          'left-edge hover reveals table of contents',
        );
        await js(
          `document.querySelector('button[aria-label="显示目录"]').click()`,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="目录"]').dataset.open`,
          ),
          'true',
          'clicking the TOC reveal edge leaves the TOC open',
        );
        await shot('00-edge-toc');
        const ratioWithToc = await js(
          `(() => { const a=document.querySelector('[aria-label="正文"]').parentElement.getBoundingClientRect().width; const b=document.querySelector('[aria-label="本书笔记"]').getBoundingClientRect().width; return b/(a+b); })()`,
        );
        assert.ok(
          Math.abs(ratioBeforeToc - ratioWithToc) < 0.06,
          'TOC opening preserves reading/note ratio',
        );
        await click('隐藏目录');
        contents.sendInputEvent({ type: 'mouseMove', x: 500, y: 160 });
        await wait(
          `document.querySelector('[aria-label="目录"]').dataset.open==='false'`,
          'TOC leaves remaining reading layout when pointer departs',
        );
        contents.sendInputEvent({ type: 'mouseMove', x: 500, y: 1 });
        await wait(
          `document.querySelector('[role="toolbar"][aria-label="阅读控制台"]').getBoundingClientRect().top>=0`,
          'top-edge hover reveals console',
        );
        const refTopBefore = await js(
          `document.querySelector('[aria-label="正文"]').scrollTop`,
        );
        await js(
          `document.querySelector('article a[href^="#reader-"]').click()`,
        );
        await wait(
          `document.querySelector('[aria-label="引用内容"]')?.textContent.includes('引用目标内容应该在气泡显示')`,
          'reference bubble shows target text',
        );
        assert.equal(
          await js(`document.querySelector('[aria-label="正文"]').scrollTop`),
          refTopBefore,
          'citation preview does not jump to target',
        );
        await shot('00-reference-bubble');
        const initialViewportWidth = await js('innerWidth');
        const [initialWindowWidth, initialWindowHeight] = testWindow.getSize();
        testWindow.setSize(initialWindowWidth - 120, initialWindowHeight);
        await wait(
          `innerWidth < ${initialViewportWidth} && (() => {const e=document.querySelector('[aria-label="引用内容"]');if(!e)return false;const r=e.getBoundingClientRect();return r.left>=16 && r.right<=innerWidth-16;})()`,
          'reference bubble stays visible after resize',
        );
        testWindow.setSize(initialWindowWidth, initialWindowHeight);
        await wait(
          `innerWidth===${initialViewportWidth} && Boolean(document.querySelector('[aria-label="引用内容"]'))`,
          'reference bubble remains after restoring window size',
        );
        await click('关闭引用内容');
        contents.sendInputEvent({
          type: 'mouseMove',
          x: 400,
          y: 300,
        });
        await type('阶段四笔记：保留用户文字。');
        await saved();
        await js(
          `(() => {const e=document.querySelector('[aria-label="笔记正文"]');const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));})()`,
        );
        await click('加粗', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] b, [aria-label="笔记正文"] strong'))`,
          ),
          true,
          'bold style applies',
        );
        const selectNote = async () =>
          js(
            `(() => { const e=document.querySelector('[aria-label="笔记正文"]'); const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())) if(n.textContent.includes('阶段四笔记')) { const r=document.createRange(); r.selectNodeContents(n); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return; } throw Error('Note text unavailable'); })()`,
          );
        await selectNote();
        await click('清除格式', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] b, [aria-label="笔记正文"] strong, [aria-label="笔记正文"] h2, [aria-label="笔记正文"] ul, [aria-label="笔记正文"] ol, [aria-label="笔记正文"] blockquote'))`,
          ),
          false,
          'format clear removes inline and block styles',
        );
        await selectNote();
        await click('标题', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] h2'))`,
          ),
          true,
          'heading style applies',
        );
        await selectNote();
        await click('标题', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] h2'))`,
          ),
          false,
          'heading style toggles off on second click',
        );
        for (const [label, selector] of [
          ['项目列表', 'ul'],
          ['有序列表', 'ol'],
        ]) {
          await selectNote();
          await click(label, noteScope);
          await saved();
          assert.equal(
            await js(
              `Boolean(document.querySelector('[aria-label="笔记正文"] ${selector}'))`,
            ),
            true,
            `${label} applies`,
          );
          await selectNote();
          await click(label, noteScope);
          await saved();
          assert.equal(
            await js(
              `Boolean(document.querySelector('[aria-label="笔记正文"] ${selector}'))`,
            ),
            false,
            `${label} cancels`,
          );
        }
        await selectNote();
        await click('引用', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] blockquote'))`,
          ),
          true,
          'quote style applies',
        );
        await selectNote();
        await click('引用', noteScope);
        await saved();
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="笔记正文"] blockquote'))`,
          ),
          false,
          'quote style toggles off on second click',
        );
        contents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 });
        await js(`document.activeElement?.blur()`);
        await select('阶段四原文片段');
        await shot('00-selection-palette');
        await click('蓝色划线');
        await wait(
          `Boolean(document.querySelector('article [data-highlight-color="blue"]'))`,
          'selected color applies in place',
        );
        await js(
          `document.querySelector('article [data-highlight-color="blue"]').click()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="划线批注"]'))`,
          'highlight opens its annotation bubble',
        );
        await js(
          `(() => {const editor=document.querySelector('[aria-label="笔记正文"]');editor.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));editor.focus();return new Promise(resolve=>requestAnimationFrame(resolve));})()`,
        );
        assert.equal(
          await js(
            `document.activeElement===document.querySelector('[aria-label="笔记正文"]')`,
          ),
          true,
          'outside dismissal preserves focus in the clicked note editor',
        );
        await js(
          `document.querySelector('article [data-highlight-color="blue"]').click()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="划线批注"]'))`,
        );
        await js(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',bubbles:true}))`,
        );
        await wait(
          `document.querySelector('[aria-label="目录"]').dataset.open==='true'`,
        );
        await js(
          `[...document.querySelectorAll('#reader-toc button')].find(button=>button.textContent.includes('第二章 转场测试')).click()`,
        );
        await wait(
          `document.querySelector('article')?.textContent.includes('用于验证跨章后清理旧批注气泡')`,
        );
        assert.equal(
          await js(
            `Boolean(document.querySelector('[aria-label="划线批注"]'))`,
          ),
          false,
          'chapter navigation dismisses stale annotation bubble',
        );
        await js(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',bubbles:true}))`,
        );
        await wait(
          `document.querySelector('[aria-label="目录"]').dataset.open==='true'`,
        );
        await js(`document.querySelector('#reader-toc button').click()`);
        await wait(
          `document.querySelector('article')?.textContent.includes('阶段四原文片段用于稳定回跳')`,
        );
        await select('阶段四原文片段');
        await click('插入选区到笔记');
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===1`,
        );
        await click('撤销', noteScope);
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===0`,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').textContent.includes('保留用户文字')`,
          ),
          true,
        );
        await click('重做', noteScope);
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===1`,
        );
        await click('专注模式');
        await wait(
          `document.querySelector('#reader-notes').hidden`,
          'focus mode hides notes',
        );
        await select('合成段落0');
        await click('插入选区到笔记');
        await wait(
          `!document.querySelector('#reader-notes').hidden && document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===2`,
          'note insertion exits focus mode and reveals its result',
        );
        await click('撤销', noteScope);
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===1`,
        );
        await js(`document.querySelector('#reader-notes-toggle').click()`);
        await wait(`document.querySelector('#reader-notes').hidden`);
        await select('另一段原文');
        await js(
          `(() => {const transfer=new DataTransfer(); window.__notesDrag=transfer; document.querySelector('article').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));})()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="拖到此处打开笔记"]'))`,
          'dragging reveals right blank-area note target',
        );
        await shot('00-drag-note-target');
        await js(
          `(() => {const forged=new DataTransfer();forged.setData('application/x-reader-selection','external-forged-token');document.querySelector('[aria-label="笔记正文"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:forged}));})()`,
        );
        assert.equal(
          await js(
            `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length`,
          ),
          1,
        );
        await js(
          `(() => {const e=document.querySelector('[aria-label="拖到此处打开笔记"]');const box=e.getBoundingClientRect();e.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__notesDrag}));e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__notesDrag,clientX:box.x+30,clientY:box.y+30}));})()`,
        );
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===2`,
          'real dragstart/drop adds scoped reference',
        );
        assert.equal(
          await js(`document.querySelector('#reader-notes').hidden`),
          false,
          'dropping in right blank area opens note',
        );
        await saved();
        await click('A+');
        await js(`document.querySelector('[data-note-jump]').click()`);
        await wait(
          `document.querySelector('article [data-emphasis="jump"]')?.textContent.includes('阶段四原文片段')`,
          'citation jump after typography change',
        );
        await shot('01-notes-sources');
        await select('合成段落0');
        await click('写批注');
        await wait(
          `Boolean(document.querySelector('textarea[name="annotation"]'))`,
        );
        await js(
          `document.querySelector('textarea[name="annotation"]').focus()`,
        );
        await contents.insertText('汇入的批注想法，不覆盖用户文字。');
        await click('保存批注');
        await wait(
          `[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='此条批注汇入笔记' && !b.disabled)`,
        );
        await click('此条批注汇入笔记');
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===3`,
        );
        await click('全部批注汇入笔记');
        await wait(`document.body.innerText.includes('已跳过重复项')`);
        assert.equal(
          await js(
            `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length`,
          ),
          3,
        );
        await click('撤销', noteScope);
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===2`,
        );
        await click('全部批注汇入笔记');
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===3`,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').textContent.includes('保留用户文字')`,
          ),
          true,
        );
        for (const [selection, text] of [
          ['合成段落2', '后位置先创建'],
          ['合成段落1', '前位置后创建'],
        ]) {
          await select(selection);
          await click('写批注');
          await wait(
            `Boolean(document.querySelector('textarea[name="annotation"]'))`,
          );
          await js(
            `document.querySelector('textarea[name="annotation"]').focus()`,
          );
          await contents.insertText(text);
          await click('保存批注');
          await wait(
            `[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='此条批注汇入笔记' && !b.disabled)`,
          );
        }
        await click('全部批注汇入笔记');
        await wait(
          `document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]').length===5`,
        );
        const importedOrder = await js(
          `[...document.querySelectorAll('[aria-label="笔记正文"] [data-note-source]')].slice(-2).map(e=>e.firstElementChild.textContent)`,
        );
        assert.deepEqual(importedOrder, ['合成段落1', '合成段落2']);
        await saved();
        await shot('02-imported-annotation');
        await click(
          '关闭',
          `document.querySelector('[aria-label="本书划线与批注"]')`,
        );
        await js(
          `(() => {const e=document.querySelector('[aria-label="笔记正文"]');const r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));})()`,
        );
        await type(' 尚未自动保存的恢复输入');
        await click('导出恢复副本', noteScope);
        await wait(`document.body.innerText.includes('已导出包含当前输入')`);
        assert.ok(
          JSON.parse(
            fs.readFileSync(path.join(root, 'unsaved-note-copy.json'), 'utf8'),
          ).html.includes('尚未自动保存'),
        );
        const before = await js(
          `document.querySelector('[aria-label="笔记正文"]').innerHTML`,
        );
        await js(`document.querySelector('#reader-notes-toggle').click()`);
        assert.equal(
          await js(`document.querySelector('#reader-notes').hidden`),
          true,
        );
        await js(`document.querySelector('#reader-notes-toggle').click()`);
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').innerHTML.startsWith(${JSON.stringify(before)})`,
          ),
          true,
        );
        await click('专注模式');
        await wait(`document.querySelector('#reader-notes').hidden`);
        await js(
          `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
        );
        await wait(`!document.querySelector('#reader-notes').hidden`);
        const separator = await js(
          `Boolean(document.querySelector('[role="separator"]'))`,
        );
        assert.equal(separator, true);
        const initialWidth = await js(
          `document.querySelector('[role="separator"]').getAttribute('aria-valuenow')`,
        );
        await js(
          `document.querySelector('[role="separator"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`,
        );
        await wait(
          `document.querySelector('[role="separator"]').getAttribute('aria-valuenow')!==${JSON.stringify(initialWidth)}`,
        );
        await wait(
          `window.reader.load('settings').then(r=>r?.data.notesLayout?.width===Number(document.querySelector('[role="separator"]').getAttribute('aria-valuenow')))`,
          'layout write acknowledged',
        );
        const pointerWidth = await js(
          `Number(document.querySelector('[role="separator"]').getAttribute('aria-valuenow'))`,
        );
        const point = await js(
          `(() => {const r=document.querySelector('[role="separator"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+Math.min(80,r.height/2))}})()`,
        );
        contents.focus();
        await js(
          `window.__pointerDown=false;window.__notePointer=[];['pointerdown','pointermove','gotpointercapture','lostpointercapture'].forEach(type=>document.addEventListener(type,e=>window.__notePointer.push({type,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,id:e.pointerId,role:e.target.getAttribute('role')}))); document.querySelector('[role="separator"]').addEventListener('pointerdown',()=>window.__pointerDown=true,{once:true})`,
        );
        assert.equal(
          await js(
            `document.elementFromPoint(${point.x},${point.y})?.getAttribute('role')`,
          ),
          'separator',
        );
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        contents.sendInputEvent({
          type: 'mouseDown',
          ...point,
          button: 'left',
          clickCount: 1,
          modifiers: ['leftButtonDown'],
        });
        await wait('window.__pointerDown', 'native splitter pointer down');
        contents.sendInputEvent({
          type: 'mouseMove',
          x: point.x - 24,
          y: point.y,
          movementX: -24,
          movementY: 0,
          modifiers: ['leftButtonDown'],
        });
        await wait(
          `Number(document.querySelector('[role="separator"]').getAttribute('aria-valuenow'))!==${pointerWidth}`,
          'native pointer resize',
        );
        contents.sendInputEvent({
          type: 'mouseUp',
          x: point.x - 24,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await wait(
          `window.reader.load('settings').then(r=>r?.data.notesLayout?.width===Number(document.querySelector('[role="separator"]').getAttribute('aria-valuenow')))`,
          'pointer layout persisted',
        );
        const layout = await js(
          `window.reader.load('settings').then(r=>r?.data.notesLayout)`,
        );
        assert.ok(layout?.width);
        await shot('02-resized-notes');
        const win = BrowserWindow.fromWebContents(contents);
        win.setSize(650, 760);
        await wait(
          `innerWidth < 700 && document.querySelector('#reader-notes').getAttribute('role') === 'dialog' && document.querySelector('#reader-notes').hidden`,
          'responsive drawer layout has committed before toggling',
        );
        await js(`document.querySelector('#reader-notes-toggle').click()`);
        await wait(`!document.querySelector('#reader-notes').hidden`);
        await shot('03-narrow-drawer');
        await saved();
        await js(
          `document.querySelector('[aria-label="关闭笔记抽屉"]').click()`,
        );
        await click('返回书架');
        await wait(
          `Boolean([...document.querySelectorAll('h2')].find(e=>e.textContent==='synthetic-notes-b'))`,
        );
        await js(
          `([...document.querySelectorAll('h2')].find(e=>e.textContent==='synthetic-notes-b')).closest('button').click()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="笔记正文"][contenteditable="true"]'))`,
        );
        await js(`document.querySelector('#reader-notes-toggle').click()`);
        await wait(`!document.querySelector('#reader-notes').hidden`);
        await type('第二本独立笔记，切书前立即输入。');
        await js(
          `document.querySelector('[aria-label="关闭笔记抽屉"]').click()`,
        );
        await click('返回书架');
        await wait(
          `Boolean([...document.querySelectorAll('h2')].find(e=>e.textContent==='synthetic-notes-a'))`,
        );
        await js(
          `([...document.querySelectorAll('h2')].find(e=>e.textContent==='synthetic-notes-a')).closest('button').click()`,
        );
        await wait(
          `Boolean(document.querySelector('[aria-label="笔记正文"][contenteditable="true"]'))`,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').textContent.includes('第二本独立笔记')`,
          ),
          false,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').textContent.includes('保留用户文字')`,
          ),
          true,
        );
        const books = await js('window.reader.libraryList()');
        const bookA = books.find((book) => book.title === 'synthetic-notes-a');
        const savedA = await js(
          `window.reader.loadNote({bookId:${JSON.stringify(bookA.bookId)}})`,
        );
        assert.equal(JSON.parse(savedA.document).sources.length, 5);
        await js(
          `window.reader.libraryRemove(${JSON.stringify(bookA.bookId)},true)`,
        );
        fs.writeFileSync(
          path.join(root, 'expected.json'),
          JSON.stringify({
            bookId: bookA.bookId,
            document: savedA.document,
            layout,
          }),
        );
        console.log('NOTES_GUI_INITIAL_PASS', {
          revision: savedA.revision,
          sources: 5,
          layout,
        });
      } else {
        const expected = JSON.parse(
          fs.readFileSync(path.join(root, 'expected.json'), 'utf8'),
        );
        await wait(
          `Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='查看保留笔记'))`,
          'retained library loaded',
        );
        await js(`document.querySelector('details').open=true`);
        await click('查看保留笔记');
        await wait(
          `Boolean(document.querySelector('[aria-label="笔记正文"][contenteditable="true"]'))`,
        );
        assert.equal(
          await js(
            `document.querySelector('[aria-label="笔记正文"]').textContent.includes('尚未自动保存')`,
          ),
          true,
        );
        await wait(`document.body.innerText.includes('位置丢失')`);
        assert.equal(
          await js(`document.querySelectorAll('[data-note-source]').length`),
          5,
        );
        if (stage === 'close-check') {
          assert.equal(
            await js(
              `document.querySelector('[aria-label="笔记正文"]').textContent.includes('正常关闭前最后输入')`,
            ),
            true,
          );
          console.log('NOTES_GUI_NATIVE_CLOSE_PASS');
          clearTimeout(deadline);
          app.quit();
          return;
        }
        assert.deepEqual(
          await js(
            `window.reader.load('settings').then(r=>r.data.notesLayout)`,
          ),
          expected.layout,
        );
        await type(' 重启后缺书仍可编辑。');
        await saved();
        const note = await js(
          `window.reader.loadNote({bookId:${JSON.stringify(expected.bookId)}})`,
        );
        assert.ok(note.document.includes('重启后缺书仍可编辑'));
        assert.ok(
          Object.values(note.resolutions).every(
            (resolution) => resolution.status === 'lost',
          ),
        );
        await shot('04-restarted-retained-notes');
        console.log('NOTES_GUI_RESTART_PASS', {
          revision: note.revision,
          lost: Object.keys(note.resolutions).length,
        });
        await type(' 正常关闭前最后输入。');
        BrowserWindow.fromWebContents(contents).close();
        return;
      }
      clearTimeout(deadline);
      app.quit();
    } catch (error) {
      console.error('NOTES_GUI_FAILED', stage, error);
      console.error(
        'POINTER_EVENTS',
        await contents
          .executeJavaScript('JSON.stringify(window.__notePointer)')
          .catch(() => 'unavailable'),
      );
      console.error(
        await contents
          .executeJavaScript('document.body.innerText.slice(-3000)')
          .catch(() => 'renderer unavailable'),
      );
      clearTimeout(deadline);
      app.exit(1);
    }
  });
});
require(path.resolve(__dirname, '../dist/apps/reader/main.js'));
