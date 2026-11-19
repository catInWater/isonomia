'use strict';

// Read only a small, inert subset of image layout. No book CSS reaches the renderer.
function length(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(px|em|rem|%)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || 'px').toLowerCase();
  const limit = unit === '%' ? 100 : unit === 'px' ? 16384 : 64;
  return amount > 0 && amount <= limit ? `${amount}${unit}` : null;
}
function declarations(source) {
  const values = {};
  for (const part of source.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (name === 'width' || name === 'height') {
      const safe = length(value);
      if (safe || value === 'auto') values[name] = safe || 'auto';
    }
    if (
      name === 'display' &&
      ['inline', 'inline-block', 'block'].includes(value)
    )
      values.display = value;
  }
  return values;
}
function imageRules(css) {
  if (typeof css !== 'string' || css.length > 65536) return [];
  const rules = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Only top-level simple rules; skip at-rules and their nested contents entirely.
  let start = 0;
  let depth = 0;
  let selector = '';
  let contentStart = 0;
  for (let index = 0; index < source.length && rules.length < 512; index++) {
    if (source[index] === '{') {
      if (depth === 0) {
        selector = source.slice(start, index).trim();
        contentStart = index + 1;
      }
      depth++;
    } else if (source[index] === '}' && depth > 0) {
      depth--;
      if (depth !== 0) continue;
      const body = source.slice(contentStart, index);
      if (!selector.startsWith('@') && !body.includes('{')) {
        for (const item of selector.split(',').slice(0, 32)) {
          const match = /^(img)?(?:([.#])([A-Za-z_][\w-]*))?$/.exec(
            item.trim(),
          );
          if (!match || (!match[1] && !match[2])) continue;
          rules.push({
            kind: match[2] || 'tag',
            name: match[3] || '',
            specificity: match[2] === '#' ? 100 : match[2] === '.' ? 10 : 0,
            values: declarations(body),
          });
        }
      }
      start = index + 1;
    } else if (source[index] === ';' && depth === 0) start = index + 1;
  }
  return rules.slice(0, 512);
}
function imageLayout(attrs, rules, dimensions) {
  const classes = String(attrs.class || '').split(/\s+/);
  const values = {};
  for (const rule of rules
    .filter(
      (rule) =>
        rule.kind === 'tag' ||
        (rule.kind === '.' && classes.includes(rule.name)) ||
        (rule.kind === '#' && attrs.id === rule.name),
    )
    .sort((a, b) => a.specificity - b.specificity)) {
    Object.assign(values, rule.values);
  }
  // Presentational attributes have lower priority than author CSS.
  const width = length(attrs.width);
  const height = length(attrs.height);
  const presentation = {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...values,
    ...declarations(String(attrs.style || '').slice(0, 4096)),
  };
  const inline =
    presentation.display === 'block'
      ? false
      : ['inline', 'inline-block'].includes(presentation.display) ||
        classes.some((name) => /^inline\d*$/.test(name)) ||
        (/^(?:\d*\.)?\d+(?:em|rem)$/.test(presentation.height || '') &&
          Number.parseFloat(presentation.height) <= 3);
  return {
    width: dimensions.width,
    height: dimensions.height,
    inline,
    ...(presentation.width && presentation.width !== 'auto'
      ? { displayWidth: presentation.width }
      : {}),
    ...(presentation.height && presentation.height !== 'auto'
      ? { displayHeight: presentation.height }
      : {}),
  };
}
module.exports = { imageRules, imageLayout };
