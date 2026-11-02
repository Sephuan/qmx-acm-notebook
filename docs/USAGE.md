# 使用指南

[返回首页](../README.md) · [维护与发布](RELEASING.md)

## 安装和启动

从[客户端 Releases](https://github.com/qmx-acm-data/qmx-acm-notebook/releases) 的 **Assets** 下载适合的成品：

- **安装版**：运行 `QMX-Notebook-Setup-<version>.exe`。这是 Windows 当前用户的 NSIS 安装程序，无需管理员权限，会创建桌面和开始菜单快捷方式，并在安装完成时提供启动选项。仅在浏览器下载文件不会创建快捷方式。卸载会保留个人数据。
- **便携版**：仅在该版本提供时下载 `QMX-Notebook-Windows-x64.zip`，解压后运行「启动.cmd」或 `QMX-Notebook.exe`。保留整个目录，不能只复制 exe；便携版不自动创建快捷方式。

GitHub 自动附带的 **Source code (zip)** / **Source code (tar.gz)** 是源码归档，不是安装包或可直接运行的便携包。当前未购买代码签名证书，Windows 可能显示未知发布者提示，请核对下载来源。

若便携版普通启动失败，可尝试「兼容启动.cmd」。普通脚本使用 `--disable-gpu`；兼容脚本另加 `--no-sandbox`，会关闭 Chromium 进程沙箱、降低进程隔离能力。当前验证机器曾出现 Electron 原生沙箱启动失败，兼容启动已验证可运行；页面仍启用 `contextIsolation`、关闭 `nodeIntegration` 并清洗 Markdown。

## 首次设置与 GitHub 登录

无需登录即可保存本地记录、读取公开资料。设置中的资料仓库默认是 `qmx-acm-data/2026`，与客户端下载仓库不同。

需要投稿时，向队伍负责人取得已启用 Device Flow 的 OAuth App **Client ID**，在右上角设置中填写；它是公开应用标识，不是 Client Secret 或个人 Token。应用注册与归属由[维护者管理](RELEASING.md#归属与许可证)。

点击左下角登录按钮，在浏览器打开的 [GitHub 设备授权页](https://github.com/login/device)输入客户端显示的验证码并确认。登录后可提交错题 Issue、发表评论，或把正式题解提交到本人 Fork，再向资料仓库发起 PR。

OAuth 请求 `public_repo` 权限，涉及该用户有权限操作的公开仓库，不能限定为这一个资料仓库。组织若限制第三方 OAuth 应用，需要组织负责人批准。不要向其他人提供个人 Token 或 Client Secret。

## 本地记录与同步

「我的错题」独立展示本机私人记录和本人提交的共享记录；本地记录、草稿、收藏和复习状态不会自动公开。只有明确点击公开提交、评论或题解提案操作时才写入 GitHub；公共仓库的 Issue、评论和 PR 对所有人公开。

点击同步获取资料仓库 `problems/`、`algorithms/` 下的 Markdown 正式资料及 Issues。内容以实际同步结果为准。这不是逐字实时协作，其他设备需要同步后才能看到公共变化；私人记录不随公共同步上传。

客户端按文件 SHA 缓存正文并分页读取。匿名 GitHub API 常见额度为每 IP 每小时 60 次，登录后通常为每用户每小时 5000 次，受 GitHub 当前政策及其他应用共享用量影响。避免频繁点击同步，免费平台政策不由本项目保证。

### 正式 Markdown 元数据

题解使用 YAML front matter，兼容 `pid`、`title`、`platform`、`tags`、`author`、`date`，另支持可选 `rating` 和 `difficulty`：

```yaml
---
pid: CF1A
title: Theatre Square
platform: CF
rating: 1000
difficulty: ''
tags: [数学, 实现]
author: github-login
date: 2026-11-01
---
```

CF 使用 rating 分数与色阶，其他平台显示原生 difficulty 文字，不跨平台换算。难度须由提交者填写或资料已有字段提供，当前不会自动抓取平台 rating。

快速错题 Issue 的正文中包含隐藏的 `qmx-record` JSON 元数据，例如：

```html
<!-- qmx-record {"schema":1,"pid":"CF1A","platform":"CF","tags":["数学"],"problemUrl":"https://codeforces.com/problemset/problem/1/A","cohort":"2026","rating":1000,"difficulty":""} -->
```

`schema: 1` 是 Issue 元数据格式版本，不是 Markdown front matter 的必填字段。保留该标记可让客户端识别题号、平台、标签和难度，无需普通队员设置 GitHub Labels 的权限。

## 数据安全与备份

数据通常保存在当前 Windows 用户的 `%APPDATA%\qmx-acm-notebook`，便携版也使用该用户数据目录：

| 文件 | 内容 |
| --- | --- |
| `local.json` | 私人记录、草稿、收藏及复习状态等本地内容 |
| `cache.json` | 公共资料缓存 |
| `auth.json` | 加密的登录信息 |

不要分享整个用户数据目录。在设置中导出本地 JSON 备份，并妥善保存。首版没有界面导入功能；恢复时可由维护者协助恢复 `local.json`，操作前先退出客户端并备份原文件。卸载保留数据不等于已有独立备份。

GitHub 网络请求由 Electron 主进程执行，渲染页面不接触令牌。令牌通过 Electron `safeStorage` 使用 Windows 用户凭据加密保存；退出登录会删除本机凭据。若要撤销远端授权，请前往 [GitHub 应用授权设置](https://github.com/settings/applications)。客户端不包含管理员凭据。

Markdown 经 DOMPurify 清洗，页面禁止网络连接和远端图片。外部链接由主进程校验，只允许 GitHub 及当前支持题目平台的 HTTPS 地址。

## 当前限制

- v0.1.0 为预览版。已实现设备授权、Issue、评论和 Fork / PR 调用，但尚未用真实队员账号完成客户端 OAuth 登录与在线写入验收。浏览器曾发布一条明确标记的 CF1A 测试 Issue，这不代表客户端投稿已通过验收。
- 公开提交依赖网络、仓库权限与组织 OAuth 策略。首次 Fork 可能尚未准备好，按提示稍后重试。写请求超时后先到 GitHub 检查是否已经成功，避免连续重试造成重复投稿。
- 尚未实现已有记录的公共正文编辑、PR 后续跟进编辑、图片或其他附件上传、自动去重、私人记录多设备同步，以及本地备份的界面导入。
- 直接打开源码中的 `ui/index.html` 只会进入带明确示例标记的界面演示，不是实际桌面客户端。
