# WindowsAfterInstall

Windows 安装后常用设置 / 软件部署脚本。Node.js + [@clack/prompts](https://www.npmjs.com/package/@clack/prompts) 终端界面，Aria2 多线程下载，SDIO 自动安装驱动，可一键打包成无依赖自包含 exe。

## 环境要求

- Node.js 24 LTS（开发 / 打包）
- pnpm 9+
- 目标机器：Windows 10 / 11，x64 架构（ARM64 与更低版本会被拒绝退出）

## 目录结构

```
src/
  index.js        入口：系统检测 → 权限提升 → 驱动安装(可重试/跳过) → 后续步骤
  sysinfo.js      系统信息采集与校验（PowerShell UTF-8）
  spawn.js        子进程启动、Aria2 下载、SDIO 调用、SEA 资源释放、UAC 提权
scripts/
  fetch-aria2.js  下载 Aria2 Windows 二进制到 bin/aria2/
  fetch-sdio.js   下载 Snappy Driver Installer Origin 到 bin/sdio/sdio.zip
  build-standalone.js  打包自包含 exe（SEA + 内嵌 aria2c.exe + sdio.zip）
bin/aria2/        aria2c.exe（运行时依赖，gitignore）
bin/sdio/         sdio.zip（运行时依赖，gitignore）
build/            打包产物 wai.exe（gitignore）
```

## 常用命令

```bash
pnpm install                # 安装依赖
pnpm run fetch:all          # 下载 aria2 + SDIO 到 bin/
pnpm start                  # 运行脚本（开发）
pnpm run build:standalone   # 打包成 build/wai.exe（自包含，无需 Node.js）
```

## 流程

1. 系统信息检测：非 Win10/11、非 x64 直接退出。
2. 管理员权限门控：未提权则询问，选“是”通过 UAC（`Start-Process -Verb RunAs`）重新拉起自身。
3. 驱动安装：询问是否自动联网下载并安装缺失/更优驱动，选“是”调用 SDIO。
   出错时可选 **重试 / 跳过此步骤继续后续流程 / 退出**。
4. 后续配置/部署步骤（待扩展，接在 `index.js` 的 TODO 处）。

## 关键实现

- **系统检测**：`sysinfo.js` 通过 PowerShell `Get-CimInstance` 取系统版本（强制 UTF-8 避免中文乱码），`net session` 退出码判断管理员权限。非 Win10/11 或非 x64 直接退出。
- **子进程**：`spawn.js#runExecutable` 用 `stdio: 'inherit'` 持续透传子进程 stdout/stderr，`error`/`exit` 统一封装为 Promise，异常信息含完整命令行。
- **Aria2 下载**：`spawn.js#aria2Download` 调 aria2c，`--split` / `--max-connection-per-server` 控制多线程连接数，默认 16。
- **SDIO 驱动安装**：`spawn.js#runSdioAutoInstall` 生成安装脚本（基于官方 oakslabs 模板，`enableinstall on`），调用 `SDIO_x64_R830.exe -script:<file> -autoclose`，联网下载索引后安装缺失/更优驱动。SDIO 从内嵌 `sdio.zip` 释放到 `%TEMP%\wai-sdio\`。
- **UAC 提权**：`spawn.js#relaunchElevated` 用 PowerShell `Start-Process -Verb RunAs` 重启自身，参数按 Windows 规范双引号包裹后以单字符串 `-ArgumentList` 透传，含空格/特殊字符亦稳。
- **自包含 exe**：`build-standalone.js` 用 esbuild 打包成单文件 CJS → Node SEA 生成 blob → `postject` 注入 `node.exe`；aria2c.exe 与 sdio.zip 作为 SEA asset 内嵌，运行时释放到临时目录。

## 自定义入口打包

```bash
WAI_ENTRY=src/selftest.js pnpm run build:standalone
```
