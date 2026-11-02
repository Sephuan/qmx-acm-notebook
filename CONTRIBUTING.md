# 参与开发

[项目首页](README.md) · [用户使用指南](docs/USAGE.md) · [维护与发布](docs/RELEASING.md)

## 环境与命令

使用 Node.js 24 和 `package.json` 指定的 pnpm 10.28.2。在源码根目录执行：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

若环境未提供 Corepack，可自行安装对应版本的 pnpm。

提交代码变更前运行：

```powershell
pnpm check
pnpm test
```

本地 Windows 构建命令：

```powershell
pnpm package
pnpm dist
```

`pnpm package` 仅生成便携目录 `release/QMX-Notebook-win32-x64`；`pnpm dist` 先构建该目录，再通过 electron-builder 生成当前用户 NSIS 安装程序 `release/installer/QMX-Notebook-Setup-<version>.exe`。打包使用独立暂存目录收集运行依赖。发布工作流与成品验收见[维护与发布](docs/RELEASING.md)。

图形驱动相关启动问题可使用 `--disable-gpu`。当前受管理环境的自动化桌面检查额外使用过 `--no-sandbox`，该参数仅供必要时验证，不能据此宣称默认发行启动已通过；兼容启动的安全取舍见[使用指南](docs/USAGE.md#安装和启动)。

## 贡献约定

- 每个 PR 说明解决的问题、用户行为变化、验证结果和剩余限制。小范围修改保持职责集中，目录分工见[首页目录图](README.md#源码目录)。
- 界面变更需检查本地保存、标签筛选、收藏、复习状态和公开库同步。使用演示模式或测试仓库，不要向正式资料库提交测试记录。
- 不提交依赖目录、构建产物、私人错题、`auth.json`、个人 Token 或 OAuth Secret。Client ID 可公开配置，但修改队伍默认值应由维护者决定。
- GitHub 写入必须由用户明确操作触发。保留主进程凭据边界、Markdown 清洗和外部链接校验，不扩大渲染页面权限。
- 不将模拟测试描述为在线授权或投稿成功；当前真实账号验收状态以[发布记录](docs/RELEASING.md#当前已核实状态)为准。

源码推送或 PR 会触发 **Source checks**，执行语法检查和单元测试。纯文档变更无需额外运行测试，但应检查链接、命令及现状表述是否准确。
