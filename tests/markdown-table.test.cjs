'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Marked } = require('marked');
const { tokenize } = require('../ui/markdown-table.js');
// The table helper receives the production formula scanner; this fixture isolates
// table splitting with complete delimited spans and leaves TeX content untouched.
function formula(source) {
  const match = /^(\$\$[\s\S]+?\$\$|\$[^\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/.exec(source);
  return match ? { raw: match[0] } : undefined;
}
function lex(source) {
  const parser = new Marked({ tokenizer: { table(source) { return tokenize(source, this, formula) || false; } } });
  return parser.lexer(source);
}
function table(row, header = '| Formula | Meaning |', delimiter = '| :--- | ---: |') {
  return lex(`${header}\n${delimiter}\n${row}\n`)[0];
}
test('table math preserves absolute-value pipes, TeX backslashes, and arrays verbatim', () => {
  for (const tex of [String.raw`$|x|$`, String.raw`$\|x\|$`, String.raw`$\left|x\right|$`, String.raw`$\text{a|b}$`, String.raw`$\begin{matrix}a&b\\c&d\end{matrix}$`, String.raw`\(x|y\)`, String.raw`\[x|y\]`]) {
    const result = table(`| ${tex} | meaning |`);
    assert.equal(result.type, 'table'); assert.equal(result.header.length, 2);
    assert.equal(result.rows[0][0].text, tex); assert.equal(result.rows[0][1].text, 'meaning');
    assert.deepEqual(result.align, ['left', 'right']);
  }
});
test('math-bearing headers keep their original column count and raw source length', () => {
  const source = '| $|x|$ | Meaning |\n| :--- | ---: |\n| value | text |\n\nAfter table';
  const tokens = lex(source), result = tokens[0];
  assert.equal(result.type, 'table'); assert.equal(result.header[0].text, '$|x|$');
  assert.equal(source.slice(0, result.raw.length), result.raw);
  assert.equal(tokens.at(-1).text, 'After table');
});
test('code-span pipes stay within cells and only matching backtick runs close code', () => {
  for (const code of ['`a|b`', '``a`|b``', '```a``|b```']) {
    const result = table(`| ${code} | code |`);
    assert.equal(result.rows[0][0].text, code); assert.equal(result.rows[0][1].text, 'code');
    assert.equal(result.rows[0][0].tokens[0].type, 'codespan');
  }
});
test('ordinary GFM escaping, empty cells, and row padding/truncation remain compatible', () => {
  assert.equal(table(String.raw`| ordinary\|pipe | other |`).rows[0][0].text, 'ordinary|pipe');
  assert.equal(table(String.raw`| even\\| other |`).rows[0][0].text, String.raw`even\\`);
  assert.equal(table(String.raw`| odd\\\|pipe | other |`).rows[0][0].text, String.raw`odd\\|pipe`);
  assert.deepEqual(table('| only |').rows[0].map(cell => cell.text), ['only', '']);
  assert.deepEqual(table('| one | two | three |').rows[0].map(cell => cell.text), ['one', 'two']);
  assert.deepEqual(table('| | second |').rows[0].map(cell => cell.text), ['', 'second']);
  assert.equal(lex('| one | two |\n| --- |\n| value | text |')[0].type, 'paragraph');
});
test('math pipes at row boundaries remain content with optional outer delimiters', () => {
  for (const row of [String.raw`$|x|$ | $\|y\|$`, String.raw`| $|x|$ | $\|y\|$ |`]) {
    assert.deepEqual(table(row).rows[0].map(cell => cell.text), [String.raw`$|x|$`, String.raw`$\|y\|$`]);
  }
  assert.deepEqual(table(String.raw`\| left | right\|`).rows[0].map(cell => cell.text), ['| left', 'right|']);
  assert.deepEqual(table('one || three', '| One | Two | Three |', '| --- | --- | --- |').rows[0].map(cell => cell.text), ['one', '', 'three']);
});
test('table inline Markdown still uses native lexer and completed code stays literal', () => {
  const result = table('| **bold** and *emphasis* | `$|x|$` |');
  assert.ok(result.rows[0][0].tokens.some(token => token.type === 'strong'));
  assert.ok(result.rows[0][0].tokens.some(token => token.type === 'em'));
  assert.equal(result.rows[0][1].tokens[0].type, 'codespan');
  assert.equal(result.rows[0][1].tokens[0].text, '$|x|$');
});
