import { intro, outro, spinner, confirm, select } from '@clack/prompts';
import pc from 'picocolors';
import {
  relaunchElevated,
  runSdioAutoInstall,
  createResumeTask,
  deleteResumeTask,
  restartComputer,
  isResumeArg,
  isUacDisabled,
  disableUac,
} from './spawn.js';
import { assertWindows10AndX64, collectSystemInfo, printSystemInfo } from './sysinfo.js';
import {
  loadStatus,
  resetStatus,
  markCurrent,
  markCompleted,
  markFinished,
  isStepDone,
} from './status.js';

/** 有序步骤列表；后续配置/部署步骤追加到此数组即可自动获得续跑能力。 */
const STEPS = [
  { id: 'driver_install', run: runDriverInstallStep },
  { id: 'disable_uac', run: runDisableUacStep },
  // TODO: 后续步骤接在这里，例如 { id: 'tweaks', run: runTweaksStep }
];

async function main() {
  intro(pc.bgCyan(pc.black(' WindowsAfterInstall 部署脚本 ')));

  const info = await collectSystemInfo();
  printSystemInfo(info);

  try {
    assertWindows10AndX64(info);
  } catch (err) {
    console.error(pc.red(`❌ ${err.message}`));
    outro(pc.red('系统检测不通过，脚本已退出。'));
    process.exit(1);
  }

  // 管理员权限门控：无权限则提示提升，选“是”通过 UAC 重新拉起自身（透传参数）
  if (!info.isAdmin) {
    console.error(pc.yellow('⚠ 当前未以管理员权限运行。'));
    const elevate = await confirm({
      message: '需要管理员权限才能继续，是否现在提升权限（将弹出 UAC）？',
      initialValue: true,
    });
    if (!elevate) {
      outro(pc.red('需要管理员权限，脚本已退出。'));
      process.exit(1);
    }
    const s = spinner();
    s.start('正在通过 UAC 提升权限并启动新的管理员实例...');
    try {
      relaunchElevated();
      s.stop('已启动管理员实例（新窗口），当前窗口将退出。');
      process.exit(0);
    } catch (err) {
      s.stop(pc.red(`提升权限失败: ${err.message}`));
      outro(pc.red('脚本已退出。'));
      process.exit(1);
    }
  }

  // ── 以下为提权后的实例 ──
  // 清理一次性恢复任务（幂等），保证任务只在“请求重启”后存在一次
  await deleteResumeTask();

  // SEA: argv=[exe,'/resume']；dev: argv=[node,'src/index.js','/resume']。
  // 用 slice(1) 扫描可同时覆盖两种情况。
  const resumeArg = process.argv.slice(1).some(isResumeArg);
  let status = await loadStatus();

  if (resumeArg) {
    // /resume：自动续跑，不询问
    if (!status || status.finished) {
      console.log(pc.dim('未发现未完成的进度，从头开始执行。'));
      status = await resetStatus();
    } else {
      console.log(pc.cyan('检测到 /resume 参数，自动继续上次未完成的流程...'));
    }
  } else if (status && !status.finished) {
    // 检测到上次未完成，询问是否续跑
    const cont = await confirm({
      message: `检测到上次运行未完成（停于: ${status.currentStep || '未知步骤'}），是否继续上次流程？`,
      initialValue: true,
    });
    if (cont) {
      console.log(pc.cyan('恢复上次进度，继续执行...'));
    } else {
      status = await resetStatus();
      console.log(pc.cyan('放弃上次进度，从头开始执行...'));
    }
  } else {
    status = await resetStatus();
    console.log(pc.cyan('开始全新执行...'));
  }

  await runFlow(status);

  await markFinished();
  outro(pc.green('🎉 全部流程执行完毕。'));
  await pressAnyKeyToExit();
}

/**
 * 按顺序执行步骤；resume 时跳过已完成的步骤。每步前后写盘。
 */
async function runFlow(status) {
  for (const step of STEPS) {
    if (isStepDone(status, step.id)) {
      console.log(pc.dim(`↷ 跳过已完成步骤: ${step.id}`));
      continue;
    }
    await markCurrent(step.id);
    await step.run();
    await markCompleted(step.id);
    status = await loadStatus();
  }
}

/**
 * 驱动自动安装步骤：询问 → 调 SDIO 联网下载安装 → 出错可重试/跳过。
 * 成功安装后提示重启，选“是”则创建一次性任务计划并自动重启。
 */
async function runDriverInstallStep() {
  const want = await confirm({
    message: '是否自动联网下载并安装缺失/更优驱动（SDIO）？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('已跳过驱动安装。'));
    return;
  }

  let installed = false;
  while (true) {
    const s = spinner();
    s.start('正在通过 SDIO 联网下载并安装驱动，此过程可能需要几分钟...');
    try {
      await runSdioAutoInstall();
      s.stop('✅ 驱动安装流程完成');
      installed = true;
      break;
    } catch (err) {
      s.stop(pc.red(`❌ 驱动安装出错: ${err.message}`));
      const action = await select({
        message: '驱动安装步骤失败，如何处理？',
        initialValue: 'retry',
        options: [
          { value: 'retry', label: '重试此步骤' },
          { value: 'skip', label: '跳过此步骤，继续后续流程' },
          { value: 'abort', label: '退出脚本' },
        ],
      });
      if (action === 'skip') {
        console.log(pc.dim('已跳过驱动安装步骤。'));
        return;
      }
      if (action === 'abort') {
        outro(pc.red('用户中止脚本。'));
        await pressAnyKeyToExit();
        process.exit(1);
      }
      // retry → 继续循环
    }
  }

  if (installed) {
    const restart = await confirm({
      message: '驱动安装完成，建议重启以使驱动生效。是否现在重启？（重启后将自动继续未完成步骤）',
      initialValue: true,
    });
    if (restart) {
      // 先把本步进度落盘，再创建任务计划与重启
      await markCompleted('driver_install');
      const s = spinner();
      s.start('正在创建开机自启任务计划并准备重启...');
      try {
        await createResumeTask();
        s.stop('已创建开机自启任务，系统即将重启');
      } catch (err) {
        s.stop(pc.red(`创建任务计划失败: ${err.message}`));
        outro(pc.red('无法创建恢复任务，已取消重启。请手动重启后用 /resume 续跑。'));
        await pressAnyKeyToExit();
        process.exit(1);
      }
      outro(pc.yellow('系统即将重启，重启登录后将自动继续...'));
      await restartComputer();
      process.exit(0);
    }
  }
}

/**
 * 禁用 UAC 弹窗步骤：若已禁用则提示并跳过；否则询问是否禁用，是则写注册表（立即生效）。
 */
async function runDisableUacStep() {
  if (isUacDisabled()) {
    console.log(pc.dim('UAC 弹窗已禁用，跳过此步骤。'));
    return;
  }
  const want = await confirm({
    message: '是否禁用 UAC 弹窗（管理员提权时不再弹出确认窗）？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('未禁用 UAC，跳过。'));
    return;
  }
  await disableUac();
  console.log(pc.green('✅ 已禁用 UAC 弹窗（立即生效）'));
}

/**
 * 等待用户按任意键后退出。避免双击运行 exe 时窗口一闪而过。
 * 非 TTY 环境（如管道）直接放行。
 */
function pressAnyKeyToExit() {
  return new Promise((resolve) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      resolve();
      return;
    }
    console.log(pc.dim('按任意键退出...'));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', () => {
      try {
        stdin.setRawMode(false);
      } catch {
        // 忽略
      }
      resolve();
    });
  });
}

main().catch(async (err) => {
  console.error(pc.red(`\n未处理异常: ${err.stack || err.message}`));
  try {
    await pressAnyKeyToExit();
  } catch {
    // 忽略
  }
  process.exit(1);
});
