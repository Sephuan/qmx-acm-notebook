# Markdown 与 LaTeX 数学公式

题解详情与算法笔记共用 Markdown 与 KaTeX 数学渲染。卡片仅显示标题、标签及状态等信息，不显示正文预览。以下数学语法说明适用于 v1.2.1 及后续版本。

## 基本写法

行内公式使用 `$...$` 或 `\(...\)`：

```latex
时间复杂度为 $O(n\log n)$，第 \(i\) 项记为 \(a_i\)。
```

独立公式使用 `$$...$$` 或 `\[...\]`，可以跨行：

```latex
\[
\sum_{i=1}^{n} i=\frac{n(n+1)}{2}
\]
```

单美元公式紧邻内容书写，避免 `$ x $`，不要跨行。正文金额建议写成 `\$5`；代码片段与代码块内的公式保持原文。公式内的 `_`、`*`、反斜杠与 HTML 比较符不按 Markdown 解释。

## 下标、括号与中文

下括号的说明通过下标 `_` 放置：

```latex
$$
1,\underbrace{0,\ldots,0}_{k\text{ 个}},
1,\underbrace{0,\ldots,0}_{k\text{ 个}},\ldots
$$
```

多字符上下标用花括号，如 `a_{i+1}`、`2^{k+1}`；文本说明使用 `\text{...}`。按 KaTeX 支持范围使用分式、根式、求和、积分、上下括号与自动伸缩括号等数学命令。

## 对齐、矩阵与分段函数

支持 KaTeX 的 `equation`、`equation*`、`align`、`align*`、`alignat`、`alignat*`、`gather`、`gather*` 等数学环境，可直接写完整环境；`aligned`、`alignedat`、`gathered`、`split`、矩阵、`array`、`cases` 等也可放入独立公式中。

```latex
\begin{align*}
f_i &= f_{i-1}+f_{i-2} \\
f_0 &= 0,\quad f_1=1
\end{align*}

$$
A=\begin{pmatrix}1&2\\3&4\end{pmatrix},\qquad
f(x)=\begin{cases}x^2&x\ge0\\-x&x<0\end{cases}
$$
```

`alignat` / `alignedat` 需要列对数参数，例如 `\begin{alignat}{2}...\end{alignat}`。`displaymath`、`math` 被兼容为独立／行内数学公式。

TeX `%` 注释持续到该公式源码的本行末尾；注释中的定界符与环境结束标记不会提前结束公式。需要显示百分号时写 `\%`。

## 表格、列表与引用

支持 Markdown 标题、强调、列表、引用、删除线、表格、链接、代码和只读任务状态标记。公式可混排在标题、列表、引用和表格单元格内。

```markdown
| 表达式 | 含义 |
| --- | --- |
| $|x|$ | 绝对值 |
| $\|v\|$ | 范数 |
| $P(A|B)$ | 条件概率 |
```

公式和完整行内代码中的 `|` 不会分裂表格列。普通文本中的表格竖线仍写 `\|`。Markdown 表格的一行仍须写在同一源码行；复杂多行数学布局建议放到表格外。

宽公式、表格、代码块在详情页各自横向滚动。左侧卡片只显示紧凑摘要，点击卡片查看完整内容；卡片中的链接显示文字，不单独跳转。

## 宏、编号与错误提示

同一篇内容内可用 KaTeX 支持的 `\newcommand`、`\def` 等定义数学宏，后续公式可引用；不同文档、卡片与详情分别初始化宏，不互相影响。宏展开次数和排版尺寸设有限制，递归宏不会无限展开。

支持 KaTeX 的 `\tag{...}` 及其原生环境编号行为。**不提供文档级连续编号、`\label`／`\ref`／`\eqref` 的交叉引用**。

错误或不支持的公式保留 TeX 源码，以点线标出，悬停可查看错误原因；同篇后续公式继续渲染。渲染不会自动补下标或改写公式的数学含义。

## 支持范围

使用 KaTeX 数学语法，不是完整 TeX / LaTeX 文档编译器。不支持 `\documentclass`、`\usepackage`、TikZ、任意宏包、文件读取，以及当前 KaTeX 不支持的 `multline` 环境。多行公式可改用 `aligned` 或 `gathered`。命令支持参考 [KaTeX 支持列表](https://katex.org/docs/supported.html)。

Markdown 内容仍经过 HTML 清洗；数学渲染关闭信任模式，不允许公式加载远程图片、执行脚本或注入任意 HTML。
