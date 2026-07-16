# Mountie

开源的 RaiDrive 替代品 —— 把云存储 / 远程协议(WebDAV、SFTP、FTP、S3…)一键挂载成 Windows 本地盘符的现代化 GUI。

> **架构:rclone 做发动机 + Tauri 做外壳。** 挂载与传输能力全部委托给成熟的 [rclone](https://github.com/rclone/rclone),本项目专注于把它封装成小白也能用的图形界面。

## 为什么

RaiDrive 的后端能力早已被开源方案完全覆盖(rclone 支持 70+ 后端;[WinFsp](https://winfsp.dev/) 提供 Windows 用户态文件系统)。RaiDrive 的价值在于易用性 —— Mountie 用开源方式复刻这份易用性:

- **快** —— GUI 用 [Tauri](https://tauri.app/)(Rust + Web),几 MB 体积、原生性能;传输由 rclone 的多线程 + VFS 缓存驱动
- **方便** —— 表单化配置远程、选盘符一键挂载,无需碰命令行
- **性能预设** —— 「极速 / 均衡 / 省内存」一键套用 rclone 的 VFS 缓存、分块、预读等参数

## 功能状态

**MVP(当前)**
- [x] 远程配置管理(WebDAV / SFTP / FTP / S3,增删)
- [x] 一键挂载为盘符 + 性能预设
- [x] 挂载状态与实时速率
- [x] WinFsp 检测引导

**规划中**
- [ ] 直传 / 同步面板(`rclone copy/sync`,绕过挂载层跑满带宽)
- [ ] OAuth 后端(Google Drive / OneDrive / Dropbox)
- [ ] 系统托盘 + 开机自启
- [ ] 跨平台(macOS / Linux)

## 技术栈

| 层 | 选择 |
|---|---|
| 挂载 / 传输引擎 | rclone(打包为 Tauri sidecar) |
| Windows 文件系统 | WinFsp |
| GUI | Tauri v2 + React + TypeScript + Vite |
| 集成方式 | GUI 通过 rclone RC HTTP API 驱动一个本机 `rclone rcd` 守护进程 |

## 开发

前置:[Node.js](https://nodejs.org/)、[Rust](https://rustup.rs/)、[WinFsp](https://winfsp.dev/rel/)(运行挂载时需要)。

```powershell
# 1. 安装前端依赖
npm install

# 2. 拉取 rclone 二进制到 sidecar 位置(binaries/ 已 gitignore)
pwsh scripts/fetch-rclone.ps1

# 3. 启动开发模式
npm run tauri dev
```

打包:

```powershell
npm run tauri build
```

### Windows + OneDrive 注意

若仓库位于 OneDrive 同步目录,cargo 会因同步锁定而在执行 build script 时报 `Access denied (os error 5)`。仓库内 `.cargo/config.toml`(gitignored)已把编译输出目录重定向到 OneDrive 之外。克隆到非同步目录则无需此文件。

## 安全说明

`rclone rcd` 仅绑定 `127.0.0.1`,并使用每次启动随机生成的凭据,不对外暴露。

## 许可

[MIT](./LICENSE)。本项目通过命令行/API 调用 rclone(MIT),不修改其源码。
