<div align="center">

<img src="build/icon.png" width="96" alt="DSH Dock">

# DSH Dock · DSH 引擎坞

**deepseek-harness 可视化启动管理器 —— 点一下表盘，服务就跑起来了**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/HUIdada1/DeepSeek_harness_engine?display_name=tag)](https://github.com/HUIdada1/DeepSeek_harness_engine/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20x64-0078D6?logo=windows11&logoColor=white)](https://github.com/HUIdada1/DeepSeek_harness_engine/releases)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

安装版 · 便携版 · 双主题 · 纯中文界面 · 免命令行

<!-- 截图补好后取消下一行注释（建议放 docs/screenshot.png，主界面运行态，宽度 720） -->
<!-- <img src="docs/screenshot.png" width="720" alt="DSH Dock 主界面"> -->

</div>

---

## ✨ 为什么需要它

手动跑起 `dsh web`，你需要：配对 Node 版本 → 装 pnpm → 拉仓库 → install → build → 猜端口 → 崩了自己拉起来。

**DSH Dock 把这一切压缩成一次点击**：环境自动检测、依赖一键自愈、崩溃自动重启、关窗不断服、托盘常驻、静默热更新。

## 🎛️ 功能一览

### 启动与服务

- **表盘即电源**：点击大表盘启动 `dsh web`，再点停止；启动中刻度环旋转 + 弧线扫描，运行后转绿并每 5s 健康探测
- **分离式后台进程**：服务以 detached 独立进程运行，关窗（最小化到托盘）/ 退出管理器都不影响服务；重新打开自动回连，或收养孤儿服务
- **双启动模式**：源码模式（`pnpm dsh web`）/ npm 模式（`npx -y @deepseek-ai/dsh web`，无需仓库）
- **端口自适应**：以进程 stdout 打印的 `dsh web: http://…` 为准，不假设固定端口

### 环境与自愈

- **Node 自动检测**：PATH / nvm-windows / fnm / volta，多版本一键切换（只注入服务启动进程，不改全局），校验引擎要求 `^22.19.0 || >=24.0.0`
- **一键初始化**：corepack/pnpm → install → build，自动注入代理与镜像源，分段超时防卡死
- **故障自愈**：pnpm 缺失自动装、端口占用提示、URL 解析超时回退端口探测、崩溃退避自动重启（5s / 15s / 60s，上限 3 次）

### 托盘 / 更新 / 日志

- **托盘常驻**：启动 / 停止 / 重启 / 打开界面 / 开机自启（Task Scheduler）/ 退出（可选是否停止服务）
- **热更新**：安装版经 electron-updater 从 GitHub Releases 静默升级；便携版仅红点提示 + 手动下载；每小时自动检测，也可在设置中心立即检查 / 下载 / 安装并重启
- **遥测日志**：实时滚动、级别过滤、一键导出、跳转日志目录

### 界面

- 精密仪器面板设计，黑 / 铝双主题，JetBrains Mono + Phosphor 图标，纯中文

## 🚀 快速上手

1. **下载**：前往 [Releases](https://github.com/HUIdada1/DeepSeek_harness_engine/releases) 获取
   - `DSH-Dock-x.x.x-Setup.exe` —— 安装版，支持自动热更新（推荐）
   - `DSH-Dock-x.x.x-portable.exe` —— 便携版，免安装单文件
2. **准备**：npm 模式开箱即用；源码模式首次先在界面里点「一键初始化」（自动完成 install + build）
3. **启动**：点击表盘 → 等待刻度环转绿 → 打开日志中打印的服务地址，开始使用

> 系统要求：Windows 10 / 11（x64）

## 🔧 两种启动模式

| | 源码模式（默认） | npm 模式 |
|---|---|---|
| 命令 | `pnpm dsh web` | `npx -y @deepseek-ai/dsh web` |
| 前置 | 需要 deepseek-harness 仓库 + 一键初始化 | 无需仓库，开箱即用 |
| 适合 | 改源码 / 跟进开发分支 | 只想快速跑起来 |

## ❓ 常见问题

- **关掉窗口服务会停吗？** 不会。服务是独立后台进程，窗口只是遥控器；托盘退出时才会询问是否停止服务。
- **服务地址是多少？** 以日志中 `dsh web: http://…` 实际打印为准，不假设端口。
- **检测不到 Node？** 已支持 nvm-windows / fnm / volta，也可在设置中手动指定路径。
- **便携版能自动更新吗？** 不能，仅红点提示新版本，需手动下载替换。
- **数据存在哪？** `%APPDATA%\dsh-dock`（config.json / state.json / logs/）。
- **启动秒退 / 凭证报错？** 本地新源码与 NPM 发布包的凭证格式不兼容：源码要 `version: 1`（YAML **数字**）+ `refs:` 嵌套；NPM 旧包只要扁平 `KEY: "value"`。Dock 会按模式自愈/拦截——有本地仓库且凭证已是 v1 时自动改走「源码」模式；纯配置错误不再空转自动重启。
- **本地有仓库却像没跑到源码？** 确认启动方式是「源码」而不是「NPM」。NPM 模式走 `npx @deepseek-ai/dsh` 发布包，不会使用你选的本地仓库。
- **对话里工具显示 `Interrupted` / `reading 'prepare'`？** 这是 deepseek-harness 运行时在执行工具阶段失败后的表现，不是 Dock UI 画错。请用源码模式拉起与本地仓库一致的构建，并检查 `~/.dsh/profiles/web` 第三方插件是否引入了冲突依赖。

## 🛠️ 开发与构建

```sh
npm install       # 国内环境建议：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev       # 开发模式
npm run gen:icons # 重新生成 build/icon.ico / icon.png
npm test          # 运行测试
```

```sh
npm run dist                  # 本地打包：release/ 产出 NSIS 安装版 + 便携版
GH_TOKEN=xxx npm run release  # 打包并发布到 GitHub Releases
```

**线上发版**：更新 `package.json` 版本号 → 提交 → `git tag v0.x.0 && git push origin v0.x.0`，GitHub Actions 自动构建并发布 Release（含 latest.yml，供热更新与便携版版本检测）。

## 🤝 贡献

欢迎 Issue 与 PR：遇到问题请附上「遥测台」导出的日志。

## ⚠️ 声明

本项目是社区独立的可视化启动管理器，与 DeepSeek 官方无关；`deepseek-harness` 服务本体由其官方仓库 / npm 包提供。仅供学习与个人效率使用，请遵守相关服务条款。

## 📄 许可证

[MIT](LICENSE) © 2026 沐辉 (HUIdada1)
