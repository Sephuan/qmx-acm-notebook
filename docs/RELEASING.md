# 维护与发布

[项目首页](../README.md) · [开发环境与构建命令](../CONTRIBUTING.md) · [用户使用指南](USAGE.md)

## 仓库与源码上传

客户端仓库为 [qmx-acm-data/qmx-acm-notebook](https://github.com/qmx-acm-data/qmx-acm-notebook)；[qmx-acm-data/2026](https://github.com/qmx-acm-data/2026) 保持为默认资料库。客户端源码根目录直接对应客户端仓库根目录，`package.json`、`README.md` 和 `.github/` 不应再嵌套一层，也不要用客户端源码覆盖资料库。

首次上传前检查忽略规则和待提交内容，不得包含依赖、运行时下载缓存、构建成品或用户数据。成品放 Releases，仓库根目录不放交付 ZIP。首次发布源码可在确认当前目录及远端后执行：

```powershell
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial QMX Notebook desktop client"
git remote add origin https://github.com/qmx-acm-data/qmx-acm-notebook.git
git push -u origin main
```

若已有 Git 仓库或远端，先检查现有配置，按实际状态提交、推送，不要重复初始化或覆盖远端历史。

## 构建与版本发布

版本说明按版本保存在 [`docs/releases/`](releases/)；[v0.6.0 更新说明](releases/v0.6.0.md) 记录当前草稿 Release、构建和签名更新状态。

本地安装依赖、检查和构建的完整命令集中在 [CONTRIBUTING](../CONTRIBUTING.md#环境与命令)。发布构建使用 `pnpm dist`，同时生成便携目录与 NSIS 安装程序；仅需便携目录时使用该文档列出的独立打包命令。

1. 更新 `package.json` 的 `version` 并编写版本说明。使用 `x.y.z`：不兼容变更增加主版本、兼容新增功能增加次版本、兼容修复增加修订版本；高位增加后低位归零。一次修复发布无论修复多少问题通常只增加一次修订号；`0.x` 仍处于早期开发阶段。
2. 完成源码检查、测试和成品验收后合并到 `main`。标签必须包含当前 main 的发布工具及更新验证器，旧标签不能套用新发布流水线。确认版本号后创建并推送一个未使用过的版本标签，例如 `v0.6.1`；不要覆盖已发布的标签或成品。
3. 在 Actions → **Build desktop clients** → **Run workflow** 中选择 `main`，输入已推送的标签（例如 `v0.6.1`），再运行。工作流只签出 `main` 上的受信任工作流；它会验证标签指向 `main`、标签版本匹配、私钥 Secret 与客户端公钥匹配，然后检查、测试并构建所有支持平台。
4. 成功后检查草稿 Release 中的 Windows 安装包、便携 ZIP、其他平台包、`update-manifest.json`、`update-app.asar` 和 `SHA256SUMS.txt`。只有草稿内容验收通过后才点击 Publish release。
5. 发布正式 Release 后，在 Actions → **Prepare published update channel** → **Run workflow** 中选择 `main`，填写刚发布的标签并运行。它重新验证公开 Release 的签名、版本及 app.asar 哈希，创建只包含 `feed/manifest.json` 与 `resources/app.asar` 的分支和 PR。审查、合并该 PR 后，现有客户端才会收到应用内更新。这样不会在 Release 成品验收之前提前向用户推送更新。
6. 发布后重新下载公开成品，比对 `SHA256SUMS.txt` 并确认首页下载链接与版本对应。用户安装和数据说明统一链接到 [USAGE](USAGE.md)，不在发布流程中维护第二份教程。

Actions → **Build desktop clients** → **Run workflow** 也可只运行签名 Secret 自检（不填标签并勾选 `verify_signing_only`），不会构建或创建 Release。私钥 Secret 只会传给 main 上已审核的签名工具，不传入 PR 检查工作流。

Actions 使用仓库提供的 `GITHUB_TOKEN`，无需个人 Token。构建任务的发布作业使用 `contents: write`；更新通道作业需要 `pull-requests: write`。若仓库策略禁止 Actions 创建 PR，工作流会推送已验证分支并在摘要中给出比较链接，由维护者手动创建 PR。由 `GITHUB_TOKEN` 创建的通道分支/PR 不会自动触发普通 push/PR 检查；若未来启用必需状态检查，应另配手动检查或 GitHub App Token，不能绕过保护强行合并。组织如禁用 Actions 或限制第三方 Actions，需负责人调整策略。

## 0.3.4 起的签名更新清单

应用内更新读取默认分支 `feed/manifest.json`，按固定提交下载 `resources/app.asar`。清单通过 Ed25519 签名，公钥固定在客户端，私钥必须保存在仓库之外且备份妥善。丢失私钥后不能给已安装客户端签发新更新。

GitHub 仓库 Actions Secret `QMX_UPDATE_SIGNING_KEY_PEM` 保存与客户端内置 Ed25519 公钥匹配的 PEM 私钥。`.github/workflows/release.yml` 仅能从 `main` 手动触发：先校验已存在的稳定版本标签指向 main 历史、标签版本与该提交的 `package.json` 一致；构建/测试任务不获取私钥。签名作业只用 main 上受信任的工具读取私钥，并仅将未执行的 `app.asar` 字节及版本元数据作为输入；Secret 不写入磁盘、日志或 Release。

Windows 构建作业生成应用包，独立的受信任签名作业生成唯一签名清单。Windows 安装包、便携 ZIP 与 Linux/macOS 包均注入同一份签名应用字节；发布前验证清单签名、版本、Electron runtime 和 SHA-256。工作流先创建草稿 Release，供维护者验收。发布草稿后，从 `main` 手动运行 `activate-update.yml`，校验 Release 附件并创建仅修改 `feed/manifest.json` 与 `resources/app.asar` 的更新通道 PR；只有该 PR 审核合并后，现有客户端才会收到该更新。运行时版本变动仍需完整安装程序升级。

私钥绝不能加入源码、Release、构建 Artifact 或普通构建日志。轮换或丢失私钥无法替代已安装客户端信任的公钥；必须通过完整安装程序发布带新公钥的版本。

## 发布验收与交接

- 普通 Windows 用户验证安装无需提权、桌面与开始菜单快捷方式、安装结束启动选项，以及卸载保留个人数据。
- 在其他 Windows 机器验证便携版普通启动和兼容启动，记录所用参数。兼容模式的安全限制以 [USAGE](USAGE.md#安装和启动) 为准。
- 用测试资料库和队员账号验证设备授权、直接创建/更新/删除本人 Markdown 文件、SHA 冲突、切换账号归属、Issues 评论、退出登录及远端授权撤销。题解不创建 Issue 或 PR。不要向正式资料库添加无标记测试记录；写入验收应记录实际仓库和结果。
- 核对本地备份与恢复路径，确保交接包和源码不含个人记录或凭据。操作说明见 [USAGE](USAGE.md#数据安全与备份)。
- 组织至少保留两名可信 Owner，分别明确客户端和资料库维护者，并记录 OAuth 应用的控制权与发布权限。

## 0.4.0 Linux 与跨平台验收

2026-11-04：原生 GitHub Actions 验证运行 41668595665 全部成功，包含 Linux x64/ARM64、Windows x64、macOS Intel/Apple Silicon 构建。Linux 各运行 107 项测试（106 通过，1 项 Windows 专用 Electron helper 测试跳过），并在 Xvfb 中运行真正的打包客户端，验证干净启动、预加载 IPC、默认 OAuth、本地 Markdown 与收藏保存以及关闭重启恢复。执行文件权限、执行文件及 app.asar 哈希在测试前后不变。CI 启动仅对测试进程显式关闭 Chromium 沙箱，不能代替所有发行版默认沙箱环境验收；实际用户 OAuth 和系统钥匙环仍需分别验证。macOS 完成构建与适用测试，未进行交互式桌面验收且未签名公证，更新采用手动安装。

## 当前已核实状态

截至 2026-11-02，本次交接记录如下；未完成项应在实际验收后更新，不能以配置文件存在代替运行成功：

| 项目 | 状态 |
| --- | --- |
| 公开成品 | v0.3.0 含账号检查更新入口；旧版需首次手动安装，新版使用 GitHub 正式 Release 中带 SHA-256 的对应 Setup 安装包 |
| 本地验证 | 0.3.0 已通过 60 项接口、主进程及更新服务测试；更新界面自动下载/启动、失败中止与重试及打包后桌面本地保存／设置／同步检查通过 |
| 安装程序 | 本地安装、快捷方式及卸载保留个人数据检查通过 |
| 客户端 OAuth 与在线写入 | 需配置队伍 Client ID 并验收实际设备授权和题解文件增删改；模拟接口测试、浏览器投稿和维护工具登录不代替客户端 OAuth 验收 |
| GitHub Actions | Source checks 已于本次源码整理后在线通过；Windows 安装包构建工作流尚未在线验收 |
| 源码 | 源码直接放在客户端仓库根目录；构建成品与源码交付 ZIP 不纳入源码树 |

## 归属与许可证

负责人需注册免费的 GitHub OAuth App：Settings → Developer settings → OAuth Apps → New OAuth App。应用名可用 QMX Notebook，Homepage 填客户端仓库地址，Callback URL 可填 `http://localhost`；程序使用设备授权，不启动回调服务。启用 **Device Flow** 后记录所属账号、负责维护者、公开 Client ID 和组织批准情况，交付 Client ID 给队员。客户端填写与登录步骤仅维护在 [USAGE](USAGE.md#首次设置与-github-登录)。

Client Secret 和个人 Token 不得内置、共享或作为交接凭据。交接应用控制权应通过所属账号和组织的正式权限流程完成，并核查离任维护者权限。

项目目前在 `package.json` 中标为 `UNLICENSED`，尚未选择开源许可证；源码公开不等于授予开源使用许可。队伍决定采用 MIT 等许可证后，再添加对应 `LICENSE` 并同步更新包元数据与文档。
