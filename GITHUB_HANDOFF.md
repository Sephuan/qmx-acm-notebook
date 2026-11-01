# 上传与交接

## 推荐：客户端单独一个仓库

在 qmx-acm-data 组织下新建 `acm-notebook`（名称可改），客户端源码放这里，2026 仓库继续保存队伍资料。客户端默认连接 qmx-acm-data/2026，无需移动原有资料。

1. 解压源码交付包。
2. 在 GitHub 新建空仓库，不勾选自动生成 README 等文件。
3. 用 GitHub Desktop：File → Add local repository → 选择解压目录；若尚未初始化，点击 create a repository here，并确认 Local path 指向源码根目录。检查 Changes 不包含 node_modules、release、用户数据或令牌。
4. 提交后 Publish repository，选择组织与仓库名称；若已经建好远端，可在 Repository settings 中设置 remote。
5. 或使用下面的 Git 命令，将 OWNER/REPOSITORY 换成自己的仓库：

```sh
git init -b main
git add .
git commit -m "Initial QMX Notebook desktop client"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

不要把 ZIP 内的所有内容再多套一层目录；package.json、README.md、.github 应位于仓库根目录。不要上传便携版的 DLL 和 exe；成品放 Releases。

## 自动检查和生成安装包

- 推送源码或创建 PR：Source checks 运行语法检查和单元测试。
- Actions → Build Windows client → Run workflow：生成 Windows 便携 ZIP，运行成功后在 Artifacts 下载。
- 正式发版：修改 package.json version，提交后推送匹配的版本标签，例如 v0.1.1。工作流会生成一个草稿 Release，并附上便携 ZIP；维护者检查说明和安装包后再发布。
- Actions 工作流使用仓库自动提供的 GITHUB_TOKEN，不需要配置个人 Token。发布任务需要 contents:write；组织策略如禁用 Actions 或限制第三方 Actions，需要维护者调整。
- GitHub Actions 尚未在线运行验收，本地已验证打包脚本。免费用量依仓库可见性及 GitHub 套餐政策；每次提交只做轻量检查，Windows 打包手动或标签触发。

## 如果必须放入现有 2026 仓库

不要用源码包覆盖资料仓库根目录。将客户端放在 `client/`，保留原 README、CONTRIBUTING、problems、algorithms 和原 .github 内容。

客户端 .github/workflows 下的两个文件需移到仓库根 .github/workflows，并给执行步骤配置 `working-directory: client`；pnpm/action-setup 的 package_json_file 改为 client/package.json，setup-node 的 cache-dependency-path 改为 client/pnpm-lock.yaml。打包、归档、上传产物路径加 client/ 前缀。根目录 Git 忽略规则应覆盖 client/node_modules、client/release 等。

独立客户端仓库更容易发布版本，后续也能连接 2027 等不同届别的资料仓库。

## 交接清单

- 组织至少两名可信 Owner；客户端和资料库按职责安排维护者。
- 记录 OAuth App 的所属账号、Client ID、Device Flow 开关；永远不要交付 Client Secret 或共享个人 Token。
- 为普通队员账号验收：登录、Issue 提交、评论、Fork PR、退出登录。
- 验收普通启动和兼容启动，并明确兼容启动禁用 Chromium 进程沙箱的取舍。
- 确认本地 JSON 备份方式及数据路径；本地私人数据不在源码库中。
- 仓库暂标 UNLICENSED，不自动授予开源使用许可；由队伍决定 MIT 等许可证后再添加 LICENSE 和更新 package.json。
