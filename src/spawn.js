import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
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

// ─── 任务计划 / 重启 / 续跑参数 ───────────────────────────────────────────
const RESUME_TASK_NAME = 'WAI_Resume';

/** 判断某个命令行参数是否为 resume 标志（兼容 / - -- 三种前缀）。 */
export function isResumeArg(a) {
  const s = String(a).toLowerCase();
  return s === '/resume' || s === '-resume' || s === '--resume';
}

/** 同步执行一段 PowerShell，非零退出抛错（除非 ignoreError）。 */
function runPowerShell(script, { ignoreError = false } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status !== 0 && !ignoreError) {
    const err = (r.stderr || '').toString().trim();
    throw new Error(err || `PowerShell 退出码 ${r.status}`);
  }
  return r;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 创建一次性任务计划：用户登录时以最高权限启动本脚本并带 /resume 参数。
 * 用于重启后无缝续跑。需管理员权限。
 */
export async function createResumeTask() {
  const exe = process.execPath;
  // 透传当前参数，去除已有的 resume 标志后追加一个，避免重复
  const args = process.argv
    .slice(1)
    .filter((a) => !isResumeArg(a))
    .concat(['/resume']);
  const argStr = args.map((a) => `"${a}"`).join(' ');
  const cwd = path.dirname(exe);
  const user = process.env.USERNAME || os.userInfo().username;

  const ps = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute ${psQuote(exe)} -Argument ${psQuote(argStr)} -WorkingDirectory ${psQuote(cwd)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(user)}
$principal = New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName ${psQuote(RESUME_TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`.trim();

  runPowerShell(ps);
  console.log(pc.green(`✅ 已创建开机自启任务计划: ${RESUME_TASK_NAME}`));
}

/**
 * 删除一次性任务计划（幂等，不存在不报错）。
 */
export async function deleteResumeTask() {
  const ps = `Unregister-ScheduledTask -TaskName ${psQuote(RESUME_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`;
  runPowerShell(ps, { ignoreError: true });
}

/**
 * 重启计算机：shutdown /r /t 5。需管理员权限。
 */
export async function restartComputer() {
  console.log(pc.yellow('系统将在 5 秒后重启...'));
  await runExecutable('shutdown.exe', ['/r', '/t', '5', '/c', 'WindowsAfterInstall: 重启以继续未完成的流程']);
}

// ─── UAC 注册表 ────────────────────────────────────────────────────────────
const UAC_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';

/** 读取一个 REG_DWORD 值，不存在返回 null。 */
function readRegDword(key, value) {
  const r = spawnSync('reg.exe', ['query', key, '/v', value], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/0x[0-9a-fA-F]+\b/);
  return m ? parseInt(m[0], 16) : null;
}

/**
 * 判断 UAC 弹窗是否已被禁用。
 * ConsentPromptBehaviorAdmin=0 且 PromptOnSecureDesktop=0 表示管理员提权不弹窗。
 * 缺省值：ConsentPromptBehaviorAdmin=5, PromptOnSecureDesktop=1。
 */
export function isUacDisabled() {
  const consent = readRegDword(UAC_KEY, 'ConsentPromptBehaviorAdmin') ?? 5;
  const secure = readRegDword(UAC_KEY, 'PromptOnSecureDesktop') ?? 1;
  return consent === 0 && secure === 0;
}

/**
 * 禁用 UAC 弹窗：写两个注册表值。需管理员权限，重启后生效。
 */
export async function disableUac() {
  await runExecutable('reg.exe', ['add', UAC_KEY, '/v', 'ConsentPromptBehaviorAdmin', '/t', 'REG_DWORD', '/d', '0', '/f']);
  await runExecutable('reg.exe', ['add', UAC_KEY, '/v', 'PromptOnSecureDesktop', '/t', 'REG_DWORD', '/d', '0', '/f']);
}

// ─── Windows Defender ───────────────────────────────────────────────────────
// 参考 Sordum Defender Control 等开源做法。目标系统 LTSC 2021 (19044) 默认开启
// Tamper Protection，会回滚纯注册表/PowerShell 的修改，故提供「温和」「硬核」两种模式。
const DEFENDER_DIR = `${process.env.ProgramFiles || 'C:\\Program Files'}\\Windows Defender`;
const DEFENDER_DIR_DISABLED = `${DEFENDER_DIR}.disabled`;
const DEFENDER_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender';
const DEFENDER_FEATURES_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Features';
const DEFENDER_TASK_PATH = '\\Microsoft\\Windows\\Windows Defender';

/** 写一个 REG_DWORD 值（自动创建键）。 */
async function writeRegDword(key, value, data) {
  await runExecutable('reg.exe', ['add', key, '/v', value, '/t', 'REG_DWORD', '/d', String(data), '/f']);
}

/** 查询服务启动类型：返回 0xN 数字，查询失败返回 null。 */
function getServiceStartType(service) {
  const r = spawnSync('sc.exe', ['qc', service], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/START_TYPE\s*:\s*(0x[0-9a-fA-F]+)/);
  return m ? parseInt(m[1], 16) : null;
}

/**
 * 判断 Windows Defender 是否已被禁用。任一强信号命中即视为已禁用：
 *  - WinDefend 服务启动类型为 4（disabled）
 *  - Defender 目录不存在，或已存在 .disabled 重命名残留
 *  - 实时保护关闭 且 策略 DisableAntiSpyware=1
 */
export function isDefenderDisabled() {
  // 服务启动类型
  const startType = getServiceStartType('WinDefend');
  if (startType === 4) return true;

  // 目录被重命名 / 不存在
  let dirExists = true;
  try {
    statSync(DEFENDER_DIR);
  } catch {
    dirExists = false;
  }
  let disabledDirExists = false;
  try {
    statSync(DEFENDER_DIR_DISABLED);
    disabledDirExists = true;
  } catch {
    // 不存在
  }
  if (!dirExists || disabledDirExists) return true;

  // 辅证：实时保护关闭 + 策略禁用
  const antispy = readRegDword(`${DEFENDER_POLICY_KEY}`, 'DisableAntiSpyware');
  if (antispy === 1) {
    let realtimeOn = null;
    try {
      const r = runPowerShell(
        '(Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled',
        { ignoreError: true }
      );
      const v = (r.stdout || '').toString().trim().toLowerCase();
      if (v === 'true') realtimeOn = true;
      else if (v === 'false') realtimeOn = false;
    } catch {
      // Defender 已损坏/不可查询，忽略
    }
    if (realtimeOn === false) return true;
  }
  return false;
}

/** 禁用 Defender 计划任务（枚举 \Microsoft\Windows\Windows Defender\* 逐个 Disable）。 */
async function disableDefenderScheduledTasks() {
  const r = runPowerShell(
    `Get-ScheduledTask -TaskPath ${psQuote(DEFENDER_TASK_PATH + '\\')} -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }`,
    { ignoreError: true }
  );
  const names = (r.stdout || '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    await runExecutable('schtasks.exe', [
      '/Change',
      '/TN',
      `${DEFENDER_TASK_PATH}\\${name}`,
      '/Disable',
    ]).catch(() => {
      console.log(pc.yellow(`  ⚠ 禁用计划任务失败: ${name}`));
    });
  }
}

/**
 * 温和模式：写组策略注册表 + Set-MpPreference + 禁用计划任务。
 * 完全可逆、立即生效；但 19044 + Tamper Protection 开启时可能被回滚，仅部分生效。
 */
export async function disableDefenderSoft() {
  // 关 Tamper Protection（best-effort，受保护时写不进/被回滚）
  await writeRegDword(DEFENDER_FEATURES_KEY, 'TamperProtection', 0).catch(() => {
    console.log(pc.yellow('  ⚠ 关闭 Tamper Protection 失败（可能已被保护），继续尝试其余步骤。'));
  });

  // 组策略注册表
  await writeRegDword(DEFENDER_POLICY_KEY, 'DisableAntiSpyware', 1);
  await writeRegDword(DEFENDER_POLICY_KEY, 'AllowFastServiceStartup', 0);
  await writeRegDword(DEFENDER_POLICY_KEY, 'ServiceKeepAlive', 0);
  const rtpKey = `${DEFENDER_POLICY_KEY}\\Real-Time Protection`;
  await writeRegDword(rtpKey, 'DisableRealtimeMonitoring', 1);
  await writeRegDword(rtpKey, 'DisableBehaviorMonitoring', 1);
  await writeRegDword(rtpKey, 'DisableIOAVProtection', 1);
  await writeRegDword(rtpKey, 'DisableScriptScanning', 1);
  await writeRegDword(rtpKey, 'DisableOnAccessProtection', 1);
  const spynetKey = `${DEFENDER_POLICY_KEY}\\Spynet`;
  await writeRegDword(spynetKey, 'SpynetReporting', 0);
  await writeRegDword(spynetKey, 'SubmitSamplesConsent', 2);
  const uxKey = `${DEFENDER_POLICY_KEY}\\UX Configuration`;
  await writeRegDword(uxKey, 'Notification_Suppress', 1);

  // Set-MpPreference（Tamper 开启时会失败，忽略）
  runPowerShell(
    'Set-MpPreference -DisableRealtimeMonitoring $true -DisableAntiSpyware $true -DisableBehaviorMonitoring $true -DisableIOAVProtection $true -DisableScriptScanning $true -DisableBlockAtFirstSeen $true -ErrorAction SilentlyContinue',
    { ignoreError: true }
  );

  await disableDefenderScheduledTasks();
}

/**
 * 硬核模式：温和 prep → 夺取目录所有权 → 重命名目录 → 禁用服务。
 * 需重启才能真正停用；较难逆转。Windows 允许在服务运行时重命名其目录
 * （已打开句柄仍有效，但路径消失），重启后 MsMpEng.exe 找不到路径无法启动。
 */
export async function disableDefenderHard() {
  await disableDefenderSoft();

  // 夺取目录所有权并授予 Administrators 完全控制
  await runExecutable('takeown.exe', ['/f', DEFENDER_DIR, '/r', '/d', 'Y']).catch((err) => {
    console.log(pc.yellow(`  ⚠ takeown 失败: ${err.message}`));
  });
  await runExecutable('icacls.exe', [
    DEFENDER_DIR,
    '/grant',
    '*S-1-5-32-544:F',
    '/t',
    '/c',
    '/q',
  ]).catch((err) => {
    console.log(pc.yellow(`  ⚠ icacls 授权失败: ${err.message}`));
  });

  // 若已有 .disabled 残留，先尝试清理（避免 rename 目标已存在）
  try {
    await rm(DEFENDER_DIR_DISABLED, { recursive: true, force: true });
  } catch {
    // 忽略
  }

  // 重命名目录（主手段）
  await rename(DEFENDER_DIR, DEFENDER_DIR_DISABLED).catch((err) => {
    console.log(pc.yellow(`  ⚠ 重命名 Defender 目录失败: ${err.message}（重启后可再次运行重试）`));
  });

  // 禁用服务启动类型（best-effort，受 Tamper 保护可能失败）
  for (const svc of ['WinDefend', 'WdNisSvc']) {
    await runExecutable('sc.exe', ['config', svc, 'start=', 'disabled']).catch(() => {
      console.log(pc.yellow(`  ⚠ 禁用服务 ${svc} 启动类型失败（受 Tamper 保护），目录重命名为主手段。`));
    });
  }
}
