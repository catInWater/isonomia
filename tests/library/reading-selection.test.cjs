'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const pagination = require('../../apps/reader-ui/src/app/pagination.ts');

// Model the native DOM's boundary-point ordering, including the distinct edges
// before/after an inline node. No layout or parser is needed for this contract.
function setup(wrappers = false) {
  class Element {
    constructor(dataset = {}, children = []) {
      this.nodeType = 1;
      this.dataset = dataset;
      this.children = children;
      for (const child of children) child.parentElement = this;
    }
    closest(selector) {
      const key =
        selector === '[data-content-start]' ? 'contentStart' : 'blockIndex';
      return Object.hasOwn(this.dataset, key)
        ? this
        : this.parentElement?.closest(selector);
    }
    contains(node) {
      return (
        node === this ||
        Boolean(node?.parentElement && this.contains(node.parentElement))
      );
    }
    querySelectorAll() {
      return this.children.flatMap((child) =>
        child instanceof Element
          ? [
              ...(Object.hasOwn(child.dataset, 'contentStart') ? [child] : []),
              ...child.querySelectorAll(),
            ]
          : [],
      );
    }
  }
  const runs = ['abc', 'def', 'ghi'].map(
    (text, i) =>
      new Element({ contentStart: String(i * 3), contentLength: '3' }, [
        { nodeType: 3, text },
      ]),
  );
  const paragraph = new Element(
    { blockIndex: '0' },
    wrappers ? runs.map((run) => new Element({}, [run])) : runs,
  );
  const article = new Element({}, [paragraph]);
  const coordinates = new Map();
  let cursor = 0;
  function index(node) {
    const points = [cursor++];
    if (node.nodeType === 3) {
      for (let i = 0; i < node.text.length; i++) points.push(cursor++);
    } else {
      for (const child of node.children) {
        index(child);
        points.push(cursor++);
      }
    }
    coordinates.set(node, points);
  }
  index(article);
  const at = (node, offset) => {
    const point = coordinates.get(node)?.[offset];
    assert.notEqual(point, undefined, 'valid native boundary');
    return point;
  };
  class NativeRange {
    static START_TO_START = 0;
    setStart(node, offset) {
      this.start = at(node, offset);
    }
    selectNode(node) {
      const parent = node.parentElement;
      const i = parent.children.indexOf(node);
      this.start = at(parent, i);
      this.end = at(parent, i + 1);
    }
    collapse(toStart) {
      if (!toStart) this.start = this.end;
    }
    compareBoundaryPoints(how, other) {
      assert.equal(how, NativeRange.START_TO_START);
      return Math.sign(this.start - other.start);
    }
  }
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => selection.range,
  };
  const exports = {};
  const filename =
    require.resolve('../../apps/reader-ui/src/app/reading-selection.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(
    compiled,
    {
      exports,
      Element,
      Node: { TEXT_NODE: 3 },
      Range: NativeRange,
      window: { getSelection: () => selection },
      document: { createRange: () => new NativeRange() },
      require(name) {
        assert.equal(name, './pagination');
        return pagination;
      },
    },
    { filename },
  );
  const chapter = { id: 'chapter-1', title: '正文', blocks: ['abcdefghi'] };
  return {
    article,
    paragraph,
    runs,
    select(startContainer, startOffset, endContainer, endOffset) {
      selection.range = {
        startContainer,
        startOffset,
        endContainer,
        endOffset,
      };
      // The function runs in another realm; compare the serialized public value.
      return JSON.parse(
        JSON.stringify(exports.readSelection(article, chapter)),
      );
    },
  };
}
const position = (offset) => ({
  chapterId: 'chapter-1',
  blockIndex: 0,
  offset,
});
const expected = (start, end) => ({
  start: position(start),
  end: position(end),
});

for (const wrappers of [false, true]) {
  test(`element-boundary selection excludes neighboring runs${wrappers ? ' inside links/highlights' : ''}`, () => {
    const { article, paragraph, runs, select } = setup(wrappers);
    assert.deepEqual(select(paragraph, 1, paragraph, 2), expected(3, 6));
    assert.deepEqual(select(paragraph, 0, paragraph, 1), expected(0, 3));
    assert.deepEqual(select(paragraph, 2, paragraph, 3), expected(6, 9));
    assert.deepEqual(select(article, 0, article, 1), expected(0, 9));
    assert.deepEqual(
      select(runs[0].children[0], 1, paragraph, 2),
      expected(1, 6),
    );
    assert.deepEqual(
      select(paragraph, 1, runs[2].children[0], 1),
      expected(3, 7),
    );
  });
}
