(function (global) {
  'use strict';
  function isEscaped(source, index) {
    let count = 0;
    while (index > 0 && source[--index] === '\\') count++;
    return count % 2 === 1;
  }
  function codeEnd(source, index) {
    const opening = /^`+/.exec(source.slice(index))[0];
    const runs = /`+/g; runs.lastIndex = index + opening.length;
    let match;
    while ((match = runs.exec(source))) if (match[0].length === opening.length) return match.index + opening.length;
    return -1;
  }
  function splitCells(row, count, formula) {
    const cells = []; let cell = '', leadingDelimiter = false, lastDelimiter = -1;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (!isEscaped(row, i)) {
        const math = (ch === '$' || ch === '\\') && formula(row.slice(i));
        if (math?.raw) { cell += math.raw; i += math.raw.length - 1; continue; }
        if (ch === '`') {
          const end = codeEnd(row, i);
          if (end !== -1) { cell += row.slice(i, end); i = end - 1; continue; }
        }
      }
      if (ch === '|') {
        if (isEscaped(row, i)) cell = cell.slice(0, -1) + '|';
        else {
          if (!cells.length && !cell.trim()) leadingDelimiter = true;
          lastDelimiter = i; cells.push(cell.trim()); cell = '';
        }
      } else cell += ch;
    }
    cells.push(cell.trim());
    // A leading/trailing table delimiter contributes no cell; internal empty cells do.
    if (leadingDelimiter) cells.shift();
    if (lastDelimiter >= 0 && !row.slice(lastDelimiter + 1).trim()) cells.pop();
    if (count !== undefined) {
      cells.length = Math.min(cells.length, count);
      while (cells.length < count) cells.push('');
    }
    return cells;
  }
  function tokenize(source, tokenizer, formula) {
    const cap = tokenizer.rules.block.table.exec(source);
    if (!cap || !tokenizer.rules.other.tableDelimiter.test(cap[2])) return;
    const headers = splitCells(cap[1], undefined, formula);
    const aligns = cap[2].replace(tokenizer.rules.other.tableAlignChars, '').split('|');
    if (headers.length !== aligns.length) return;
    const align = aligns.map(value => tokenizer.rules.other.tableAlignRight.test(value) ? 'right' : tokenizer.rules.other.tableAlignCenter.test(value) ? 'center' : tokenizer.rules.other.tableAlignLeft.test(value) ? 'left' : null);
    const cells = (values, header) => values.map((text, index) => ({ text, tokens: tokenizer.lexer.inline(text), header, align: align[index] }));
    const rows = cap[3]?.trim() ? cap[3].replace(tokenizer.rules.other.tableRowBlankLine, '').split('\n') : [];
    return { type: 'table', raw: cap[0], header: cells(headers, true), align, rows: rows.map(row => cells(splitCells(row, headers.length, formula), false)) };
  }
  const api = Object.freeze({ tokenize });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.NotebookMarkdownTable = api;
})(typeof window !== 'undefined' ? window : globalThis);
