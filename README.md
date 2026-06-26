# WindowsAfterInstall

Windows 安装后常用设置 / 软件部署脚本。Node.js + [@clack/prompts](https://www.npmjs.com/package/@clack/prompts) 终端界面，Aria2 多线程下载，可一键打包成无依赖自包含 exe。

## 环境要求

- Node.js 24 LTS（开发 / 打包）
- pnpm 9+
- 目标机器：Windows 10 / 11，x64 架构（ARM64 与更低版本会被拒绝退出）

## 目录结构

```
src/
  index.js        入口：系统检测 → Clack 交互 → Aria2 下载流程
  sysinfo.js      系统信息采集与校验（PowerShell UTF-8）
  spawn.js        子进程启动(实时 stdout/stderr)、Aria2 下载、SEA 资源释放
scripts/
  fetch-aria2.js  下载 Aria2 Windows 二进制到 bin/aria2/
  build-standalone.js  打包自包含 exe（SEA + 内嵌 aria2c.exe）
bin/aria2/        aria2c.exe（运行时依赖，gitignore）
build/            打包产物 wai.exe（gitignore）
```

## 常用命令

```bash
pnpm install                # 安装依赖
pnpm run fetch:aria2        # 下载 Aria2 二进制到 bin/aria2/
pnpm start                  # 运行脚本（开发）
pnpm run build:standalone   # 打包成 build/wai.exe（自包含，无需 Node.js）
```

## 关键实现

- **系统检测**：`sysinfo.js` 通过 PowerShell `Get-CimInstance` 获取系统版本（强制 UTF-8 输出避免中文乱码），`net session` 判断管理员权限。非 Win10/11 或非 x64 直接退出。
- **子进程**：`spawn.js#runExecutable` 用 `stdio: 'inherit'` 持续透传子进程 stdout/stderr，`error`/`exit` 事件统一封装为 Promise，异常信息含完整命令行。
- **Aria2 下载**：`spawn.js#aria2Download` 调用 aria2c，`--split` / `--max-connection-per-server` 控制多线程连接数，默认 16。
- **自包含 exe**：`build-standalone.js` 用 esbuild 打包成单文件 CJS → Node SEA 生成 blob → `postject` 注入 `node.exe`，aria2c.exe 作为 SEA asset 内嵌，运行时释放到 `%TEMP%\wai-bin\`。

## 自定义入口打包

```bash
WAI_ENTRY=src/selftest.js pnpm run build:standalone
```
