import { intro, outro, spinner, confirm, select } from '@clack/prompts';
import pc from 'picocolors';
import { relaunchElevated, runSdioAutoInstall } from './spawn.js';
import { assertWindows10AndX64, collectSystemInfo, printSystemInfo } from './sysinfo.js';

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

  // 管理员权限门控：无权限则提示提升，选“是”通过 UAC 重新拉起自身
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

  const ok = await confirm({
    message: '系统检测通过，是否继续运行？',
    initialValue: true,
  });
  if (!ok) {
    outro(pc.yellow('用户取消操作。'));
    process.exit(0);
  }

  await runDriverInstallStep();

  // TODO: 后续配置/部署步骤接在这里

  outro(pc.green('脚本执行完毕。'));
}

/**
 * 驱动自动安装步骤：询问是否安装 → 调 SDIO 联网下载安装 → 出错可重试/跳过。
 */
async function runDriverInstallStep() {
  const want = await confirm({
    message: '是否自动联网下载并安装缺失/更优驱动（SDIO）？',
    initialValue: false,
  });
  if (!want) return;

  while (true) {
    const s = spinner();
    s.start('正在通过 SDIO 联网下载并安装驱动，请观察 SDIO 窗口...');
    try {
      await runSdioAutoInstall();
      s.stop('✅ 驱动安装流程完成');
      return;
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
        clackNote('已跳过驱动安装步骤。');
        return;
      }
      if (action === 'abort') {
        outro(pc.red('用户中止脚本。'));
        process.exit(1);
      }
      // retry → 继续循环
    }
  }
}

function clackNote(msg) {
  console.log(pc.dim(msg));
}

main().catch((err) => {
  console.error(pc.red(`
未处理异常: ${err.stack || err.message}`));
  process.exit(1);
});
