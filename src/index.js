import { intro, outro, spinner, confirm, select, text } from '@clack/prompts';
import pc from 'picocolors';
import { runSoftwareStep } from './software.js';
import {
  relaunchElevated,
  runSdioAutoInstall,
  createResumeTask,
  deleteResumeTask,
  restartComputer,
  isResumeArg,
  isUacDisabled,
  disableUac,
  isDefenderDisabled,
  disableDefenderSoft,
  disableDefenderHard,
  downloadSmartActivateExe,
  runSmartActivate,
  isWindows11,
  isSearchboxAtIcon,
  setSearchboxToIcon,
  isNewsAndInterestsHidden,
  hideNewsAndInterests,
  isTouchKeyboardButtonShown,
  showTouchKeyboardButton,
  isDesktopIconShown,
  setDesktopIconVisibility,
  isRibbonAlwaysExpanded,
  setRibbonAlwaysExpanded,
  isClassicContextMenuEnabled,
  setClassicContextMenu,
  areHiddenFilesShown,
  areFileExtensionsShown,
  setShowHiddenFilesAndExtensions,
  isExplorerOpenToThisPC,
  setExplorerOpenToThisPC,
  restartExplorer,
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
  { id: 'disable_defender', run: runDisableDefenderStep },
  { id: 'smart_activate', run: runSmartActivateStep },
  { id: 'explorer_tweaks', run: runExplorerTweaksStep },
  { id: 'install_software', run: runSoftwareStep },
  // TODO: 后续步骤接在这里
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
 * 禁用 Windows Defender 步骤：若已禁用则提示并跳过；否则询问是否禁用，
 * 是则运行时选择温和 / 硬核模式。硬核模式需重启生效，选重启则复用续跑机制。
 */
async function runDisableDefenderStep() {
  if (isDefenderDisabled()) {
    console.log(pc.dim('Windows Defender 已禁用，跳过此步骤。'));
    return;
  }
  const want = await confirm({
    message: '是否禁用 Windows Defender？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('未禁用 Defender，跳过。'));
    return;
  }

  const mode = await select({
    message: '选择禁用模式：',
    initialValue: 'soft',
    options: [
      { value: 'soft', label: '温和：策略注册表 + PowerShell（可逆，可能被 Tamper Protection 回滚）' },
      { value: 'hard', label: '硬核：重命名 Defender 目录 + 禁用服务（彻底，需重启，较难逆转）' },
    ],
  });

  if (mode === 'soft') {
    const s = spinner();
    s.start('正在以温和模式禁用 Defender...');
    await disableDefenderSoft();
    s.stop(pc.green('✅ 已尝试禁用 Defender（温和模式，立即生效）'));
    return;
  }

  // 硬核模式
  const s = spinner();
  s.start('正在以硬核模式禁用 Defender（夺权 + 重命名目录 + 禁用服务）...');
  await disableDefenderHard();
  s.stop(pc.green('✅ 硬核禁用操作已执行，需重启才能真正停用'));

  const restart = await confirm({
    message: '硬核模式需重启才能真正停用 Defender。是否现在重启？（重启后将自动继续未完成步骤）',
    initialValue: true,
  });
  if (!restart) {
    console.log(pc.yellow('硬核模式需重启才能真正停用 Defender，请稍后手动重启。'));
    return;
  }
  // 先把本步进度落盘，再创建任务计划与重启
  await markCompleted('disable_defender');
  const s2 = spinner();
  s2.start('正在创建开机自启任务计划并准备重启...');
  try {
    await createResumeTask();
    s2.stop('已创建开机自启任务，系统即将重启');
  } catch (err) {
    s2.stop(pc.red(`创建任务计划失败: ${err.message}`));
    outro(pc.red('无法创建恢复任务，已取消重启。请手动重启后用 /resume 续跑。'));
    await pressAnyKeyToExit();
    process.exit(1);
  }
  outro(pc.yellow('系统即将重启，重启登录后将自动继续...'));
  await restartComputer();
  process.exit(0);
}

/**
 * 智能激活系统步骤：询问 → 下载 HEU KMS Activator 并 MD5 校验 → 以 /smart 模式运行。
 * 下载失败（无网络等）或 MD5 校验不通过均视为失败，可选 重试 / 跳过 / 退出。
 */
async function runSmartActivateStep() {
  const want = await confirm({
    message: '是否智能激活 Windows 系统（下载 HEU KMS Activator，以 /smart 模式静默激活）？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('已跳过系统激活。'));
    return;
  }

  while (true) {
    // 1. 下载 + MD5 校验
    let exePath;
    const s = spinner();
    s.start('正在下载激活工具并校验 MD5，此过程需要联网...');
    try {
      exePath = await downloadSmartActivateExe();
      s.stop('✅ 激活工具下载完成且 MD5 校验通过');
    } catch (err) {
      s.stop(pc.red(`❌ 下载/校验失败: ${err.message}`));
      const action = await askFailureAction('激活工具下载或 MD5 校验失败，如何处理？');
      if (action === 'skip') {
        console.log(pc.dim('已跳过系统激活步骤。'));
        return;
      }
      if (action === 'abort') {
        outro(pc.red('用户中止脚本。'));
        await pressAnyKeyToExit();
        process.exit(1);
      }
      continue; // retry
    }

    // 2. 运行激活
    const s2 = spinner();
    s2.start('正在以 /smart 模式运行激活工具，请稍候...');
    try {
      await runSmartActivate(exePath);
      s2.stop(pc.green('✅ 激活流程已执行完成'));
      return;
    } catch (err) {
      s2.stop(pc.red(`❌ 激活执行失败: ${err.message}`));
      const action = await askFailureAction('激活工具执行失败，如何处理？');
      if (action === 'skip') {
        console.log(pc.dim('已跳过系统激活步骤。'));
        return;
      }
      if (action === 'abort') {
        outro(pc.red('用户中止脚本。'));
        await pressAnyKeyToExit();
        process.exit(1);
      }
      // retry → 回到循环顶部重新下载校验（确保文件完整）
    }
  }
}

// ─── Desktop Icon CLSIDs（仅供 runExplorerTweaksStep 使用）─────────────────
const DESKTOP_THIS_PC = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}';
const DESKTOP_CONTROL_PANEL = '{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}';

/**
 * Explorer 调整步骤：询问是否调整任务栏/桌面/资源管理器，
 * 选“否”则跳过整步；选“是”则分三个类别逐一询问，每类用紧凑
 * y/n 字符串（Y=全部/ N=跳过/ yyn=逐项）选择要执行的调整项。
 * 每项标注是否已达目标值，已达标则无需再写。全部改完后重启 Explorer。
 */
async function runExplorerTweaksStep() {
  const want = await confirm({
    message: '是否调整 Explorer 设置（任务栏 / 桌面 / 资源管理器）？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('已跳过 Explorer 调整。'));
    return;
  }

  const win11 = isWindows11();
  let anythingChanged = false;

  // ── 任务栏调整 ────────────────────────────────────────────────────────────
  const taskbarItems = [];
  if (!win11) {
    taskbarItems.push({ label: '搜索框改图标', isAtTarget: isSearchboxAtIcon(), apply: setSearchboxToIcon });
  }
  taskbarItems.push({ label: '隐藏资讯/小组件', isAtTarget: isNewsAndInterestsHidden(), apply: hideNewsAndInterests });
  taskbarItems.push({ label: '显示触摸键盘按钮', isAtTarget: isTouchKeyboardButtonShown(), apply: showTouchKeyboardButton });
  const taskbarSelections = await askCategory('任务栏调整', taskbarItems);
  if (taskbarSelections) {
    for (let i = 0; i < taskbarItems.length; i++) {
      if (taskbarSelections[i] && !taskbarItems[i].isAtTarget) {
        await taskbarItems[i].apply();
        anythingChanged = true;
      }
    }
  }

  // ── 桌面调整 ──────────────────────────────────────────────────────────────
  const desktopItems = [
    {
      label: '显示此电脑图标',
      isAtTarget: isDesktopIconShown(DESKTOP_THIS_PC),
      apply: () => setDesktopIconVisibility(DESKTOP_THIS_PC, true),
    },
    {
      label: '显示控制面板图标',
      isAtTarget: isDesktopIconShown(DESKTOP_CONTROL_PANEL),
      apply: () => setDesktopIconVisibility(DESKTOP_CONTROL_PANEL, true),
    },
  ];
  const desktopSelections = await askCategory('桌面调整', desktopItems);
  if (desktopSelections) {
    for (let i = 0; i < desktopItems.length; i++) {
      if (desktopSelections[i] && !desktopItems[i].isAtTarget) {
        await desktopItems[i].apply();
        anythingChanged = true;
      }
    }
  }

  // ── 资源管理器窗口调整 ────────────────────────────────────────────────────
  const explorerItems = [];
  if (!win11) {
    explorerItems.push({ label: '始终显示功能区', isAtTarget: isRibbonAlwaysExpanded(), apply: setRibbonAlwaysExpanded });
  }
  if (win11) {
    explorerItems.push({ label: '恢复经典右键菜单', isAtTarget: isClassicContextMenuEnabled(), apply: setClassicContextMenu });
  }
  explorerItems.push({
    label: '默认显示隐藏文件和文件扩展名',
    isAtTarget: areHiddenFilesShown() && areFileExtensionsShown(),
    apply: setShowHiddenFilesAndExtensions,
  });
  explorerItems.push({
    label: '默认打开此电脑而不是快速访问',
    isAtTarget: isExplorerOpenToThisPC(),
    apply: setExplorerOpenToThisPC,
  });
  const explorerSelections = await askCategory('资源管理器窗口调整', explorerItems);
  if (explorerSelections) {
    for (let i = 0; i < explorerItems.length; i++) {
      if (explorerSelections[i] && !explorerItems[i].isAtTarget) {
        await explorerItems[i].apply();
        anythingChanged = true;
      }
    }
  }

  if (anythingChanged) {
    console.log('');
    await restartExplorer();
  } else {
    console.log(pc.dim('Explorer 调整：无需修改（所有项均已达标或已跳过）。'));
  }
}

/**
 * 向用户展示一个类别的调整项列表，标注各项是否已达目标值，接收 y/n 输入。
 *
 * @param {string} categoryName 类别名称
 * @param {{label:string, isAtTarget:boolean}[]} items
 * @returns {Promise<boolean[]|null>} 每项对应的选中状态，null 表示用户取消
 */
async function askCategory(categoryName, items) {
  console.log('\n' + pc.cyan(`=== ${categoryName} ===`));
  for (let i = 0; i < items.length; i++) {
    const prefix = items[i].isAtTarget ? pc.green('[✓已设]') : pc.dim('[       ]');
    console.log(`  ${prefix} ${i + 1}. ${items[i].label}`);
  }
  console.log('');

  const input = await text({
    message: `输入 y=执行 / n=跳过 逐项指定，或 Y=全部执行 / N=全部跳过 (${items.length}项)`,
    placeholder: 'yyn',
    validate(value) {
      const v = value.trim();
      if (v === 'Y' || v === 'y' || v === 'N' || v === 'n') return;
      if (v.length === 0) return '请输入内容';
      for (const ch of v) {
        if (ch !== 'y' && ch !== 'Y' && ch !== 'n' && ch !== 'N') {
          return `无效字符 "${ch}"，仅支持 y/Y/n/N`;
        }
      }
      if (v.length > items.length) return `输入过长，最多 ${items.length} 个字符`;
    },
  });

  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  // 单字符快捷（仅大写）：Y = 全部执行，N = 全部跳过
  if (trimmed === 'Y') return Array(items.length).fill(true);
  if (trimmed === 'N') return Array(items.length).fill(false);

  // 逐字符解析，不足补 n，多余截断
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const ch = trimmed[i] || 'n';
    result.push(ch === 'y' || ch === 'Y');
  }
  return result;
}

/** 步骤失败时的统一询问：重试 / 跳过 / 退出。 */
async function askFailureAction(message) {
  return await select({
    message,
    initialValue: 'retry',
    options: [
      { value: 'retry', label: '重试此步骤' },
      { value: 'skip', label: '跳过此步骤，继续后续流程' },
      { value: 'abort', label: '退出脚本' },
    ],
  });
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
