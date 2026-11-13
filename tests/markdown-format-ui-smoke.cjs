'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const source=String.raw`# Markdown 与公式

## 二级标题

正文内容与 **重点内容**。

### 三级标题

下面是公式与格式示例。

内联 \(a_i+b_j\)，美元 $x^2$，价格 \$5 和 \$10。

\[
\sum_{i=1}^{n} i=\frac{n(n+1)}{2}
\]

\begin{equation} E=mc^2 \tag{A} \end{equation}

\begin{align*}
a&=b+c\\
d&=e+f
\end{align*}

$$\begin{cases}x^2&x\ge0\\-x&x<0\end{cases}$$

$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$

> 引用里的 \(x_i\) 和 **加粗**。

- [x] 已完成
- [ ] 待完成
- 公式 $a_k$ 与 *斜体*

| 表达式 | 含义 |
|:---|---:|
| $|x|$ | 绝对值 |
| $\|v\|$ | 范数 |
| \(P(A|B)\) | 条件概率 |
| a|b | 代码 |

$code_i$

tex
\[literal\]
$literal$


$$\newcommand{\testmacro}{\mathbb{R}}$$
$\testmacro^2$

$$\unknowncommand{x}$$
$z_i$

<script>window.injected=true</script>
$\href{javascript:alert(1)}{unsafe}$
$\includegraphics{https://example.com/image.png}$
`.replace(/\u0010/g,'`');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(body=>{const record={id:'document:format.md',kind:'document',repo:'test/math',path:'format.md',title:'格式回归',body,author:'test',authorId:'1'};const payload={records:[record],issues:[],account:null,permissions:{repo:'test/math'},settings:{repo:'test/math',autoSync:false},local:{records:[],favorites:[],mastery:{},draft:{}}};window.notebook={bootstrap:async()=>structuredClone(payload),sync:async()=>structuredClone(payload),openExternal:async()=>{}};},source);await page.goto(pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href);await page.locator('.rail-nav-item[data-view="public"]').click();const reader=page.locator('#detail-panel .markdown-body');await reader.locator('.katex').first().waitFor();assert.equal(await reader.locator('table tbody tr').count(),4);assert.equal(await reader.locator('table td').count(),8);assert.equal(await reader.locator('table code').innerText(),'a|b');assert.equal(await reader.locator('table .katex').count(),3);assert.equal(await reader.locator('.markdown-task-marker').count(),2);assert.equal(await reader.locator('input,script,img,[onerror],a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await reader.locator('pre code').innerText(),'\\[literal\\]\n$literal$\n');assert.ok((await reader.innerText()).includes('$5 和 $10'));assert.equal(await reader.locator('.notebook-math-error').count(),1);assert.match(await reader.locator('.notebook-math-error').getAttribute('title'),/unknowncommand/);assert.ok((await reader.locator('.notebook-math-rendered').allTextContents()).some(s=>s.includes('z')));assert.equal(await reader.locator('.katex .tag').count(),1);
const isolated=await page.evaluate(()=>{function run(text){const e=document.createElement('div');e.innerHTML=DOMPurify.sanitize(NotebookMarkdownMath.parse(text,marked));NotebookMarkdownMath.render(e,katex);return e;}const a=run('$\\newcommand{\\isolated}{x}$ $\\isolated$');const b=run('$\\isolated$ $y$');const c=run('$\\def\\loop{\\loop}\\loop$ $z$');const failedMacro=run('$\\def\\frac{\\unknown}\\unknown$ $\\frac{1}{2}$ $z$');if(failedMacro.querySelectorAll('.notebook-math-error').length!==1)throw Error('Failed formula poisoned later macros');const count=a.querySelectorAll('.notebook-math-rendered').length;NotebookMarkdownMath.render(a,katex);return{aErrors:a.querySelectorAll('.notebook-math-error').length,bErrors:b.querySelectorAll('.notebook-math-error').length,bSuccess:b.querySelectorAll('.notebook-math-rendered').length,cErrors:c.querySelectorAll('.notebook-math-error').length,cSuccess:c.querySelectorAll('.notebook-math-rendered').length,idempotent:count===a.querySelectorAll('.notebook-math-rendered').length};});assert.deepEqual(isolated,{aErrors:0,bErrors:1,bSuccess:1,cErrors:1,cSuccess:1,idempotent:true});
const corpus=await page.evaluate(()=>{const examples=[String.raw`\frac{\sqrt{x^2+1}}{1+x}`,String.raw`\lim_{n\to\infty}\sum_{i=1}^{n}\frac1{i^2}`,String.raw`\int_0^1 x^2\,dx`,String.raw`\binom{n}{k}=\frac{n!}{k!(n-k)!}`,String.raw`\underbrace{0,\ldots,0}_{k\text{ 个}}`,String.raw`\left\lceil\frac{n}{2}\right\rceil`,String.raw`\begin{array}{c|c}a&b\\c&d\end{array}`,String.raw`\overrightarrow{AB}\cdot\vec v`,String.raw`\mathbb{R}\subseteq\mathbb{C}`,String.raw`\begin{alignat}{2}a&=b&c&=d\end{alignat}`];return examples.map(tex=>{const e=document.createElement('div');e.innerHTML=DOMPurify.sanitize(NotebookMarkdownMath.parse('$$'+tex+'$$',marked));NotebookMarkdownMath.render(e,katex);return{tex,errors:e.querySelectorAll('.notebook-math-error').length,rendered:e.querySelectorAll('.katex').length};});});assert.ok(corpus.every(x=>x.errors===0&&x.rendered===1),JSON.stringify(corpus));
for(const theme of ['light','dark','cards']){await page.evaluate(t=>document.body.dataset.theme=t,theme);assert.ok(await reader.locator('.katex').count()>10);const type=await reader.evaluate(e=>{const style=s=>getComputedStyle(e.querySelector(s));const strong=style('p strong'),h2=style('h2'),h3=style('h3');return{h1:parseFloat(style('h1').fontSize),h2:parseFloat(h2.fontSize),h3:parseFloat(h3.fontSize),body:parseFloat(getComputedStyle(e).fontSize),headingRule:h2.borderBottomStyle,strongWeight:parseFloat(strong.fontWeight),strongColor:strong.color,bodyColor:style('p').color,main:getComputedStyle(e).getPropertyValue('--text').trim(),synthesis:strong.fontSynthesis};});assert.ok(type.h1>type.h2&&type.h2/type.h3>=1.3&&type.h3>type.body,JSON.stringify(type));assert.equal(type.headingRule,'solid');assert.ok(type.strongWeight>=750);assert.notEqual(type.strongColor,type.bodyColor);assert.match(type.synthesis,/weight/);const cardType=await page.locator('.card-excerpt').evaluate(e=>[1,2,3].map(n=>parseFloat(getComputedStyle(e.querySelector('h'+n)).fontSize)));assert.ok(cardType[0]>cardType[1]&&cardType[1]>cardType[2],JSON.stringify(cardType));}
await page.setViewportSize({width:390,height:844});await page.locator('.record-card').press('Enter');const layout=await reader.evaluate(e=>{const long=document.createElement('div');long.innerHTML=DOMPurify.sanitize(NotebookMarkdownMath.parse('$$'+Array.from({length:50},(_,i)=>'x_{'+i+'}').join('+')+'$$',marked));NotebookMarkdownMath.render(long,katex);e.append(long);const math=long.querySelector('.katex-display');return{overflow:getComputedStyle(math).overflowX,scroll:math.scrollWidth,width:math.clientWidth,page:document.documentElement.scrollWidth,viewport:innerWidth};});assert.equal(layout.overflow,'auto');assert.ok(layout.scroll>layout.width);assert.ok(layout.page<=layout.viewport+2,JSON.stringify(layout));assert.deepEqual(errors,[]);console.log('PASS Markdown/LaTeX: delimiters, AMS, matrix/cases, tags, math tables/code pipes, tasks, literal currency, scoped macros, error isolation, expansion limits, 3 themes,390px local formula scrolling');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
