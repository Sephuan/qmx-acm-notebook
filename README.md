# 拾题 · QMX ACM Notebook

面向 ACM 集训队的 Windows 本地错题与算法资料客户端，无需自建服务器、数据库或域名。默认资料来源：[qmx-acm-data/2026](https://github.com/qmx-acm-data/2026)。

**[下载 Windows x64 安装包 v0.1.0](https://github.com/qmx-acm-data/qmx-acm-notebook/releases/download/v0.1.0/QMX-Notebook-Setup-0.1.0.exe)** · [所有版本](https://github.com/qmx-acm-data/qmx-acm-notebook/releases)

下载后运行安装程序。首次配置、登录、数据备份与已知限制见 [使用指南](docs/USAGE.md)。当前为预览版，客户端 OAuth 在线投稿尚未完成验收。

![浅色界面示例](screenshots/preview-light.png)

## 能做什么

- 阅读公共题库的 Markdown 题解、算法资料和 Issue 交流记录。
- 管理本机错题、草稿、收藏、复习状态，查看标签与进度统计。
- 明确提交后才共享错题；支持评论及通过 Fork / PR 提交正式题解。
- 展示 Markdown、公式、代码与平台原生难度，提供三种界面风格。

## 文档

- [使用指南](docs/USAGE.md)：安装、OAuth 登录、同步格式、数据安全与限制。
- [参与开发](CONTRIBUTING.md)：开发环境、检查与构建命令、贡献约定。
- [维护与发布](docs/RELEASING.md)：源码上传、版本发布、验收状态及应用归属。

## 源码目录

| 目录 | 职责 |
| --- | --- |
| `electron/` | 主进程、GitHub API、凭据与 IPC |
| `ui/` | 无 Node 权限的中文界面 |
| `tests/` | 数据处理与界面验证脚本 |
| `tools/` | Windows 打包工具 |
| `.github/workflows/` | 源码检查、Windows 构建与草稿发布 |
| `docs/` | 使用与维护文档 |

客户端发布仓库为 [qmx-acm-data/qmx-acm-notebook](https://github.com/qmx-acm-data/qmx-acm-notebook)。许可证状态与维护责任见 [维护与发布](docs/RELEASING.md#归属与许可证)。
