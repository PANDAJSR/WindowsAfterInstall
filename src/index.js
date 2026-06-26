import { intro, outro, spinner, text, confirm } from '@clack/prompts';
import pc from 'picocolors';
import { aria2Download, relaunchElevated } from './spawn.js';
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

  const testDownload = await confirm({
    message: '是否测试 aria2 下载一个 HTTP 文件？',
    initialValue: true,
  });
  if (testDownload) {
    const url = await text({
      message: '请输入要下载的 URL',
      defaultValue: 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
      placeholder: 'https://example.com/file.zip',
    });
    if (typeof url === 'string') {
      const s = spinner();
      s.start('正在使用 aria2 多线程下载...');
      try {
        const out = await aria2Download(url, './downloads', { connections: 16 });
        s.stop(`下载完成: ${out}`);
      } catch (err) {
        s.stop(pc.red(`下载失败: ${err.message}`));
        throw err;
      }
    }
  }

  outro(pc.green('脚本执行完毕。'));
}

main().catch((err) => {
  console.error(pc.red(`
未处理异常: ${err.stack || err.message}`));
  process.exit(1);
});
