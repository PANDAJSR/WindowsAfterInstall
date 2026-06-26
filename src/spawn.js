import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';

/**
 * 运行一个外部 exe，将其 stdout/stderr 连续输出到当前控制台，并在进程结束后返回退出码。
 *
 * @param {string} exePath
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<number>} exit code
 */
export function runExecutable(exePath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exePath, args, {
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      ...options,
    });

    proc.on('error', (err) => {
      reject(new Error(`启动子进程失败: ${exePath} ${args.join(' ')} → ${err.message}`));
    });

    proc.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`子进程被信号 ${signal} 终止`));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function isPackaged() {
  return (
    typeof process.getBuiltinModule === 'function' &&
    process.getBuiltinModule('node:sea')?.isSea()
  );
}

/**
 * 构造 PowerShell `Start-Process` 提权命令字符串。
 *
 * @param {object} p
 * @param {string} p.exe
 * @param {string[]} p.args
 * @param {string} p.cwd
 * @param {boolean} [p.wait]
 * @param {boolean} [p.runAs=true]
 * @returns {string}
 */
export function buildElevationCommand({ exe, args, cwd, wait = false, runAs = true }) {
  // PowerShell 单引号转义：' → ''
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // 每个参数按 Windows 命令行规范用双引号包裹，内部双引号转义为 \"
  const quotedArgs = args
    .map((a) => `"${String(a).replace(/"/g, '\\"')}"`)
    .join(' ');
  const parts = ['Start-Process', `-FilePath ${q(exe)}`];
  if (args.length) {
    parts.push(`-ArgumentList ${q(quotedArgs)}`);
  }
  if (runAs) parts.push('-Verb RunAs');
  parts.push(`-WorkingDirectory ${q(cwd)}`);
  if (wait) parts.push('-Wait');
  return parts.join(' ');
}

/**
 * 以管理员权限重新启动当前进程（触发 UAC 弹窗）。
 * 通过 PowerShell `Start-Process -Verb RunAs` 实现，保留原工作目录与参数。
 * 调用方应在成功后立即 process.exit()，让提升后的新实例接管。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.wait=false] 是否等待提升后的实例退出（默认不等待，新窗口独立运行）
 * @returns {void}
 * @throws {Error} 用户在 UAC 弹窗点击“否”或提升失败时抛出
 */
export function relaunchElevated(opts = {}) {
  const cmd = buildElevationCommand({
    exe: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    wait: opts.wait,
    runAs: true,
  });

  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
    windowsHide: false,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error('提升权限失败，可能是用户在 UAC 弹窗中选择了“否”。');
  }
}

/**
 * 获取 aria2c.exe 的绝对路径。
 * 如果处于 SEA 打包模式，会将资源释放到临时目录。
 *
 * @returns {Promise<string>}
 */
export async function getAria2BinaryPath() {
  if (isPackaged()) {
    const sea = process.getBuiltinModule('node:sea');
    const tmpDir = path.join(os.tmpdir(), 'wai-bin');
    await mkdir(tmpDir, { recursive: true });
    const aria2Path = path.join(tmpDir, 'aria2c.exe');
    try {
      await stat(aria2Path);
    } catch {
      const asset = sea.getAsset('aria2c.exe');
      const buf = Buffer.from(asset);
      await mkdir(path.dirname(aria2Path), { recursive: true });
      await finished(Readable.from([buf]).pipe(createWriteStream(aria2Path)));
      await chmod(aria2Path, 0o755);
    }
    return aria2Path;
  }

  const localBin = path.resolve(dirname(), '..', 'bin', 'aria2', 'aria2c.exe');
  try {
    await stat(localBin);
    return localBin;
  } catch {
    throw new Error(`本地 aria2c.exe 不存在: ${localBin}，请先运行 pnpm run fetch:aria2 下载。`);
  }
}

function dirname() {
  // CJS bundle (SEA) 提供 __dirname；ESM 源码运行时用 import.meta.url
  if (typeof __dirname !== 'undefined') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * 调用 aria2c 进行多线程 HTTP 下载。
 *
 * @param {string} url
 * @param {string} outDir
 * @param {object} opts
 * @param {string} [opts.out]
 * @param {number} [opts.connections=16]
 * @param {number} [opts.maxTries=5]
 * @returns {Promise<string>} 下载完成后的本地文件路径
 */
export async function aria2Download(url, outDir, opts = {}) {
  const aria2c = await getAria2BinaryPath();
  const outName = opts.out ?? (path.basename(new URL(url).pathname) || 'download');
  const targetDir = path.resolve(outDir);
  await mkdir(targetDir, { recursive: true });

  const args = [
    '--dir=' + targetDir,
    '--out=' + outName,
    '--split=' + (opts.connections ?? 16),
    '--max-connection-per-server=' + (opts.connections ?? 16),
    '--min-split-size=1M',
    '--continue=true',
    '--max-tries=' + (opts.maxTries ?? 5),
    '--retry-wait=5',
    '--console-log-level=warn',
    '--download-result=full',
    '--allow-overwrite=true',
    url,
  ];

  console.log(pc.dim(`调用 aria2c: ${aria2c} ${args.join(' ')}`));
  const code = await runExecutable(aria2c, args, { cwd: targetDir });
  if (code !== 0) {
    throw new Error(`aria2c 下载失败，退出码: ${code}`);
  }
  const finalPath = path.join(targetDir, outName);
  return finalPath;
}

/**
 * 下载 Aria2 Windows 二进制文件（开发时使用），存储到 bin/aria2/。
 *
 * @param {string} version
 * @param {string} [variant]
 */
export async function ensureLocalAria2(version = '1.37.0', variant = 'aria2-1.37.0-win-64bit-build1') {
  const binDir = path.resolve(dirname(), '..', 'bin', 'aria2');
  const exePath = path.join(binDir, 'aria2c.exe');
  try {
    await stat(exePath);
    console.log(pc.green(`aria2c.exe 已存在: ${exePath}`));
    return exePath;
  } catch {
    // proceed to download
  }

  const zipName = `${variant}.zip`;
  const url = `https://github.com/aria2/aria2/releases/download/release-${version}/${zipName}`;
  const tmpDir = path.join(os.tmpdir(), 'wai-aria2-download');
  await mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, zipName);

  await downloadWithNode(url, zipPath);
  await extractZip(zipPath, tmpDir);
  const extractedAria2 = path.join(tmpDir, variant, 'aria2c.exe');
  await mkdir(binDir, { recursive: true });
  await rename(extractedAria2, exePath);
  await rm(tmpDir, { recursive: true, force: true });
  console.log(pc.green(`✅ aria2c.exe 已就绪: ${exePath}`));
  return exePath;
}

/**
 * 使用 Node.js 内置 fetch 下载文件，带进度显示。
 */
async function downloadWithNode(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const total = +(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  await mkdir(path.dirname(dest), { recursive: true });
  const file = createWriteStream(dest);
  await finished(
    Readable.from(res.body).on('data', (chunk) => {
      downloaded += chunk.length;
      if (total) {
        process.stdout.write(`\r下载中: ${((downloaded / total) * 100).toFixed(1)}%`);
      }
    }).pipe(file)
  );
  console.log();
}

async function extractZip(zipPath, destDir) {
  await mkdir(destDir, { recursive: true });
  const { execSync } = await import('node:child_process');
  execSync(
    `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
    { stdio: 'inherit' }
  );
}

// ─── Snappy Driver Installer Origin (SDIO) ─────────────────────────────────
// SDIO 自动安装脚本：联网下载索引 → 选出缺失/更优驱动 → 安装。
// 基于官方 scripts/oakslabs-test.txt 模板，enableinstall 设为 on 以真正安装。
const SDIO_INSTALL_SCRIPT = `verbose 384
logging on
enableinstall on
init
checkupdates
get indexes
restorepoint WAI Driver Installation
select missing better
install
end
`;

/**
 * 确保 SDIO 已解压到缓存目录并返回该目录。
 * SEA 打包模式下从内嵌 sdio.zip 资源释放；开发模式从 bin/sdio/sdio.zip 释放。
 *
 * @returns {Promise<string>} SDIO 所在目录
 */
export async function getSdioDir() {
  const cacheDir = path.join(os.tmpdir(), 'wai-sdio');
  const exe = path.join(cacheDir, 'SDIO_x64_R830.exe');
  if (await fileExists(exe)) return cacheDir;

  await mkdir(cacheDir, { recursive: true });

  let zipBuf;
  if (isPackaged()) {
    const sea = process.getBuiltinModule('node:sea');
    zipBuf = Buffer.from(sea.getAsset('sdio.zip'));
  } else {
    const localZip = path.resolve(dirname(), '..', 'bin', 'sdio', 'sdio.zip');
    try {
      zipBuf = await readFile(localZip);
    } catch {
      throw new Error(`本地 SDIO zip 不存在: ${localZip}，请先运行 pnpm run fetch:sdio 下载。`);
    }
  }

  const tmpZip = path.join(cacheDir, 'sdio.zip');
  await writeFile(tmpZip, zipBuf);
  await extractZip(tmpZip, cacheDir);
  await rm(tmpZip, { force: true });

  if (!(await fileExists(exe))) {
    throw new Error(`SDIO 解压后未找到 ${exe}`);
  }
  console.log(pc.green(`✅ SDIO 已就绪: ${exe}`));
  return cacheDir;
}

/**
 * 调用 SDIO 自动联网下载并安装缺失/更优驱动。
 * 需管理员权限（由调用方保证）。
 *
 * @returns {Promise<number>} 退出码（0 表示成功）
 * @throws {Error} 启动失败或退出码非零
 */
export async function runSdioAutoInstall() {
  const dir = await getSdioDir();
  const exe = path.join(dir, 'SDIO_x64_R830.exe');
  const scriptPath = path.join(dir, 'wai_install.txt');
  await writeFile(scriptPath, SDIO_INSTALL_SCRIPT, 'utf8');

  const args = ['-script:' + scriptPath, '-autoclose'];
  console.log(pc.dim(`调用 SDIO: ${exe} ${args.join(' ')}`));
  // GUI 应用：windowsHide 设为 false 以确保窗口可见，用户可观察下载/安装进度
  const code = await runExecutable(exe, args, { cwd: dir, windowsHide: false });
  if (code !== 0) {
    throw new Error(`SDIO 执行失败，退出码: ${code}`);
  }
  return code;
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
