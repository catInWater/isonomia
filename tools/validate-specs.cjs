'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(filename)
      : filename.endsWith('.md')
        ? [filename]
        : [];
  });
}

function validate() {
  const files = [
    path.join(root, 'README.md'),
    ...walk(path.join(root, '.claude/docs')),
  ];
  const errors = [];
  const specs = files.filter((file) => /specs[/\\]\d\d-/.test(file));
  const ids = new Map();
  for (const file of specs) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^- (S\d{2}-A\d+)\b/gm)) {
      if (ids.has(match[1])) errors.push(`Duplicate acceptance ID ${match[1]}`);
      ids.set(match[1], file);
    }
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (
        !fs.existsSync(
          path.resolve(path.dirname(file), decodeURIComponent(target)),
        )
      )
        errors.push(`${path.relative(root, file)}: missing link ${target}`);
    }
    for (const match of text.matchAll(/\bS\d{2}-A\d+\b/g)) {
      if (!ids.has(match[0]))
        errors.push(
          `${path.relative(root, file)}: unknown acceptance ID ${match[0]}`,
        );
    }
  }
  const tickets = fs.readFileSync(
    path.join(root, '.claude/docs/tickets/README.md'),
    'utf8',
  );
  for (let number = 0; number <= 31; number++) {
    const id = `T-${String(number).padStart(3, '0')}`;
    if ((tickets.match(new RegExp(`^### ${id}\\b`, 'gm')) || []).length !== 1)
      errors.push(`Expected exactly one ticket heading: ${id}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `Validated ${files.length} documents and ${ids.size} acceptance IDs (local paths and literal IDs; anchors/range semantics require review)`,
  );
}

if (require.main === module) validate();
module.exports = { validate };
