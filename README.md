# DSH Dock · DSH 引擎坞

deepseek-harness 可视化启动管理器（Windows）。精密仪器面板设计，黑/铝双主题。

**作者：沐辉**

## 功能

- **表盘即电源**：点击大表盘启动 `dsh web` 服务，再点停止；启动中刻度环旋转、弧线扫描，运行后转绿色并每 5s 健康探测。
- **分离式后台进程**：服务以 detached 进程运行，关闭窗口（最小化到托盘）/ 退出管理器都不影响服务；重新打开自动回连或收养孤儿服务。
- **Node 环境**：自动检测（PATH / nvm-windows / fnm / volta），校验引擎要求 `^22.19.0 || >=24.0.0`，多版本一键切换（仅注入服务启动进程 PATH，不改全局）。
- **项目目录**：自动获取 + 自定义；一键初始化（corepack/pnpm → install → build，代理与镜像注入，分段超时）。
- **故障自愈**：pnpm 缺失自动装、端口被占提示、URL 解析超时回退端口探测、服务崩溃退避自动重启（5s/15s/60s，上限 3 次）。
- **托盘**：启动 / 停止 / 重启 / 打开界面 / 开机自启（Task Scheduler）/ 退出（询问是否停止服务）。
- **热更新**：安装版经 electron-updater 从 GitHub Releases 下载并静默升级；便携版仅提示手动下载；每小时自动检测，设置按钮红点提示；可在设置中心立即检查 / 下载 / 安装并重启。
- **日志**：遥测台实时滚动、级别过滤、导出、跳转日志目录。

## 开发

```sh
npm install          # 建议国内环境：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 启动开发模式
npm run gen:icons    # 重新生成 build/icon.ico / icon.png
```

## 构建与发布

```sh
npm run dist         # 本地打包：release/ 下产出 NSIS 安装版 + 便携版
GH_TOKEN=xxx npm run release   # 打包并发布到 GitHub Releases
```

**线上发版（推荐）**：更新 `package.json` 版本号 → 提交 → `git tag v0.1.0 && git push origin v0.1.0`，GitHub Actions 自动构建 NSIS + portable 并发布 Release（含 latest.yml，供 electron-updater 热更新与便携版版本检测）。

或推送 `v*` tag，由 GitHub Actions（workflow_dispatch）构建。

- 发布仓库：<https://github.com/HUIdada1/DeepSeek_harness_engine>
- 数据目录：`%APPDATA%\dsh-dock`（config.json / state.json / logs/）

## 面向 deepseek-harness 的两种启动方式

- 源码模式（默认）：`pnpm dsh web`，需要先一键初始化（install + build）。
- npm 模式：`npx -y @deepseek-ai/dsh web`，无需仓库，端口默认 3080。

服务真实地址以进程 stdout 打印的 `dsh web: http://…` 为准，不假设端口。
