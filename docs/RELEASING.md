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

版本说明按版本保存在 [`docs/releases/`](releases/)；[v0.6.0 更新说明](releases/v0.6.0.md) 当前是待发布草稿，源码已推送但 Release 和签名更新尚未发布。

本地安装依赖、检查和构建的完整命令集中在 [CONTRIBUTING](../CONTRIBUTING.md#环境与命令)。发布构建使用 `pnpm dist`，同时生成便携目录与 NSIS 安装程序；仅需便携目录时使用该文档列出的独立打包命令。

1. 更新 `package.json` 的 `version` 并编写版本说明。使用 `x.y.z`：不兼容变更增加主版本、兼容新增功能增加次版本、兼容修复增加修订版本；高位增加后低位归零。一次修复发布无论修复多少问题通常只增加一次修订号；`0.x` 仍处于早期开发阶段。
2. 完成源码检查、测试和成品验收后提交。确认标签版本与 `package.json` 一致，例如下一修订版使用 `v0.1.1`，不要覆盖已公开的 `v0.1.0` 标签或成品。
3. 推送提交及版本标签。`.github/workflows/release.yml` 的 **Build Windows client** 在 `v*` 标签触发时执行检查、测试、发布构建，压缩便携目录，并创建**草稿 Release**。
4. 草稿应同时包含 `QMX-Notebook-Setup-<version>.exe` 与 `QMX-Notebook-Windows-x64.zip`。核对版本说明、文件、下载大小与 SHA-256，记录验证结果后再手动发布。
5. 发布后重新下载公开成品，比对大小与 SHA-256，并确认首页下载链接与版本对应。用户安装和数据说明统一链接到 [USAGE](USAGE.md)，不在发布流程中维护第二份教程。

也可在 Actions → **Build Windows client** → **Run workflow** 手动构建：成功后从 Artifacts 下载两种成品，**手动触发不会创建草稿 Release**。工作流上传便携归档及 `release/installer/` 下的安装包。

Actions 使用仓库提供的 `GITHUB_TOKEN`，无需个人 Token。构建任务使用 `contents: write` 以创建草稿；组织如禁用 Actions 或限制第三方 Actions，需负责人调整策略。每次提交仅做轻量检查，Windows 构建采用手动或标签触发；可用免费用量取决于 GitHub 当前政策与仓库套餐。

## 0.3.4 起的签名更新清单

应用内更新读取默认分支 `feed/manifest.json`，按固定提交下载 `resources/app.asar`。清单通过 Ed25519 签名，公钥固定在客户端，私钥必须保存在仓库之外且备份妥善。丢失私钥后不能给已安装客户端签发新更新。

发布时先设置 `QMX_BUILD_UPDATE_FEED=1` 构建应用，再设置 `QMX_UPDATE_SIGNING_KEY` 为外部私钥路径并运行 `pnpm update:manifest`。脚本生成签名清单和应用包；清单版本与 package 版本必须一致。提交前检查应用包中不含个人资料或凭据。随后清除 `QMX_BUILD_UPDATE_FEED`，运行 `pnpm dist`。打包脚本验证清单和哈希，并让安装包使用同一份已签名应用字节，避免不同构建的哈希漂移。

清单及应用包应与 Release 一同发布，更新通道是默认分支上的签名清单，不以 Release 发布时间决定。运行时版本变动时需通过完整安装程序升级，不能只更新应用包。私钥绝不能加入源码、Release 或普通构建日志。GitHub Actions 使用已签名的应用包，无需持有私钥。

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
