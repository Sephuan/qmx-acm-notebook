# 算法笔记

算法笔记使用 `algorithms/notes/` 下的 Markdown 文件保存，frontmatter 约定如下：

```yaml
schema: 3
note_scope: public # public 或 personal
node_id: dp-knapsack
featured: false
author_id: 123
author: github-login
title: 0/1 背包状态设计
tags:
  - 动态规划
  - 背包
client_id: uuid
updated_at: 2026-11-08T00:00:00.000Z
```

公共笔记位于 `algorithms/notes/public/`，所有用户可阅读；个人笔记位于 `algorithms/notes/personal/<GitHub-ID>/`，仅作者可阅读。普通用户只能创建或编辑自己的个人笔记，管理员可以创建、编辑公共笔记和设置精选笔记。设置新的精选笔记时，客户端会先取消其他公共笔记的精选标记，保持同一时刻只有一个精选笔记。

客户端的“算法笔记”页提供算法树、滚轮缩放、拖拽平移、节点选择、标签/作者搜索、公共/个人切换和笔记详情阅读。正文支持 Markdown、行间公式和内联 `$...$`、`\(...\)` 公式；代码块中的美元符号不会被当作公式解析。
