'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), marked = require('marked');
const { parse } = require('../ui/markdown-math.js');
const count = html => (html.match(/class="notebook-math-source"/g) || []).length;
test('math subscripts, braces and backslashes survive Markdown interpretation', () => {
 const formula = String.raw`1,\underbrace{0,\ldots,0}_{k\text{ 个}}, 1,\underbrace{0,\ldots,0}_{k\text{ 个}}, \ldots`;
 for (const source of [`$$ ${formula} $$`, `$$\n${formula}\n$$`, '内联 $a_i + b_j$ 与 **加粗**']) {
  const html = parse(source, marked); assert.ok(!html.includes('<em>')); assert.ok(html.includes('_')); assert.equal(count(html), 1);
 }
 assert.match(parse('$a<b_i$ 与 <script>alert(1)</script>', marked), /a&lt;b_i/);
});
test('dollar, slash delimiters and common standalone environments are recognized', () => {
 for (const source of [String.raw`\(a_i+b_j\)`, String.raw`\[\frac{a}{b}\]`, String.raw`\begin{equation}x^2\tag{A}\end{equation}`, String.raw`\begin{align}x&=1\\y&=2\end{align}`, String.raw`\begin{gather*}x=1\\y=2\end{gather*}`, String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`]) assert.equal(count(parse(source, marked)), 1, source);
 assert.match(parse(String.raw`\begin{equation}x\tag{A}\end{equation}`, marked), /\\tag\{A\}/);
 assert.match(parse(String.raw`\begin{displaymath}x_i\end{displaymath}`, marked), />x_i<\/div>/);
 assert.equal(count(parse('before\n$$x_1$$\nafter', marked)), 1);
});
test('math respects groups, escaped delimiters, TeX comments and nested environments', () => {
 const source = String.raw`$\text{cost $5} + \$ + x$`;
 assert.equal(count(parse(source, marked)), 1); assert.match(parse(source, marked), /cost \$5/);
 assert.equal(count(parse('$$x % $$ ignored\n+y$$', marked)), 1);
 assert.match(parse('$$x % $$ ignored\n+y$$', marked), /ignored\n\+y/);
 const nested = String.raw`\begin{matrix}\begin{matrix}a\end{matrix}&b\end{matrix}`;
 assert.equal(count(parse(nested, marked)), 1); assert.match(parse(nested, marked), /&amp;b\\end\{matrix\}/);
});
test('math tokens leave code and ordinary Markdown intact', () => {
 const html = parse('`$a_i$`\n\n```tex\n$$ x_i $$\n\\[x\\]\n```\n\n普通 **加粗** 和 *斜体*\n\n$x_i$\n\n$$\nx_1 + x_2\n$$', marked);
 assert.match(html, /<code>\$a_i\$<\/code>/); assert.match(html, /class="language-tex">\$\$ x_i \$\$/); assert.match(html, /<strong>加粗<\/strong>/); assert.match(html, /<em>斜体<\/em>/); assert.equal(count(html), 2);
 assert.equal(count(parse('    $$x_i$$\n', marked)), 0);
 assert.equal(count(parse('> \\[x_i\\]\n\n- $a_j$\n- **B**', marked)), 2);
});
test('escaped dollars, common currency and malformed delimiters stay literal', () => {
 for (const source of [String.raw`\$x_i\$`, 'unfinished $x_i', '$a\nb$', '$5 and $10', '$ x $', String.raw`\\(x\\)`, String.raw`\[unclosed`]) assert.equal(count(parse(source, marked)), 0, source);
 assert.equal(count(parse(String.raw`$x + \$ + y$`, marked)), 1);
 assert.equal(count(parse('$5 and $10 plus $x$', marked)), 1);
 assert.match(parse('$5 and $10 plus $x$', marked), />x<\/span>/);
 assert.equal(count(parse('\\begin{equation}x % \\end{equation}\n+y\\end{equation}', marked)), 1);
 assert.match(parse('\\begin{equation}x % \\end{equation}\n+y\\end{equation}', marked), /\+y\\end\{equation\}/);
});
test('verbatim commands keep embedded math delimiters literal', () => {
 const html=parse(String.raw`$\verb|$|$ and $\verb!{%}!$`,marked);assert.equal(count(html),2);assert.match(html,/\\verb\|\$\|/);
});
test('malformed math cannot trigger repeated unbounded tail scans', () => {
 const source=Array(3000).fill(String.raw`\(x{`).join(' ')+String.raw` \)`+'\n\n# Retained\n\ntext';
 const start=performance.now(),html=parse(source,marked);assert.ok(performance.now()-start<2500);assert.match(html,/<h1>Retained<\/h1>/);
});
test('task lists retain read-only completion markers without form controls', () => {
 const html = parse('- [x] done\n- [ ] pending', marked);
 assert.match(html, /aria-label="已完成"/); assert.match(html, /aria-label="未完成"/); assert.ok(!html.includes('<input'));
});
test('GFM tables preserve formulas with absolute values and escaped pipes', () => {
 const source = '| $|x|$ | Meaning |\n|:---|---:|\n| $\\|x\\|$ | norm |\n| $P(A|B)$ | conditional |';
 const html = parse(source, marked); assert.equal(count(html), 3); assert.equal((html.match(/<td/g) || []).length, 4); assert.match(html, />\\\|x\\\|<\/span>/); assert.match(html, /align="right"/);
});
