import { exec as execCallback, execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import pc from 'picocolors';

const exec = promisify(execCallback);
const execFileP = promisify(execFile);

/**
 * @returns {Promise<{os: string, version: string, build: string, arch: string, isWin10OrHigher: boolean, isAdmin: boolean, totalMemory: string, cpu: string, machineName: string}>}
 */
export async function collectSystemInfo() {
  const platform = os.platform();
  const release = os.release();
  const arch = process.arch;
  const machineName = os.hostname();
  const totalMemory = `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`;
  const cpu = os.cpus()[0]?.model ?? 'Unknown';

  let version = 'Unknown';
  let build = 'Unknown';
  let isWin10OrHigher = false;
  let isAdmin = false;

  if (platform === 'win32') {
    try {
      const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption)|$($o.BuildNumber)|$($o.Version)"';
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', ps], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      const [cap, bld, ver] = stdout.trim().split('|');
      if (cap) version = cap;
      if (bld) build = bld;
      if (ver) {
        const major = parseInt(ver.split('.')[0] ?? '0', 10);
        isWin10OrHigher = major >= 10;
      }
    } catch {
      // fallback: use os.release() NT version
      const major = parseInt(release.split('.')[0], 10);
      isWin10OrHigher = major >= 10;
    }

    // `net session` 退出码 0 = 管理员，非零 = 非管理员（不依赖 stdout 内容，
    // 因为管理员且无会话时输出为空）
    try {
      await exec('net session', { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      isAdmin = true;
    } catch {
      isAdmin = false;
    }
  }

  return {
    os: platform,
    version,
    build,
    arch,
    isWin10OrHigher,
    isAdmin,
    totalMemory,
    cpu,
    machineName,
  };
}

export function printSystemInfo(info) {
  console.log(pc.cyan('══════════════════════════════════════════'));
  console.log(pc.cyan('  系统信息检测'));
  console.log(pc.cyan('══════════════════════════════════════════'));
  console.log(`  操作系统: ${pc.yellow(info.version)}`);
  console.log(`  Build 版本: ${pc.yellow(info.build)}`);
  console.log(`  CPU 架构:   ${pc.yellow(info.arch)}`);
  console.log(`  CPU 型号:   ${pc.yellow(info.cpu)}`);
  console.log(`  内存:      ${pc.yellow(info.totalMemory)}`);
  console.log(`  计算机名: ${pc.yellow(info.machineName)}`);
  console.log(`  管理员权限: ${info.isAdmin ? pc.green('是') : pc.red('否')}`);
  console.log(pc.cyan('══════════════════════════════════════════'));
}

export function assertWindows10AndX64(info) {
  if (info.os !== 'win32') {
    throw new Error('本脚本只能在 Windows 系统上运行。');
  }
  if (info.arch !== 'x64') {
    throw new Error(`不支持的 CPU 架构: ${info.arch}，本脚本仅支持 x64 架构。`);
  }
  if (!info.isWin10OrHigher) {
    throw new Error(`Windows 版本过低: ${info.version}，请使用 Windows 10 或 Windows 11 系统。`);
  }
}
