import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import pc from 'picocolors';
import { confirm, spinner } from '@clack/prompts';
import {
  runExecutable,
  aria2Download,
} from './spawn.js';

// ─── 软件目录定义 ────────────────────────────────────────────────────────────────
// 添加新分类只需在 CATALOG 数组末尾追加，添加新软件只需在对应 items 中追加。

const CATALOG = [
  {
    id: 'daily',
    label: '日用软件',
    items: [
      { id: 'Tencent.WeChat',                        name: '微信',         postInstall: null },
      { id: 'Tencent.QQ.NT',                         name: 'QQ',          postInstall: null },
      { id: 'ByteDance.Feishu',                      name: '飞书',        postInstall: null },
      { id: 'Daum.PotPlayer',                        name: 'PotPlayer',    postInstall: 'setDefaultPlayer' },
      { id: 'LocalSend.LocalSend',                   name: 'LocalSend',   postInstall: null },
      { id: 'Google.Chrome',                         name: 'Chrome',       postInstall: 'setDefaultBrowser' },
      { id: 'SublimeHQ.SublimeText.4',               name: 'SublimeText', postInstall: null },
      { id: 'Giorgiotani.Peazip',                    name: 'PeaZip',      postInstall: null },
      { id: 'JavadMotallebi.NeatDownloadManager',    name: 'NDM 下载器',  postInstall: null },
    ],
  },
];

// ─── Post-install 动作分发表 ──────────────────────────────────────────────────────

const POST_INSTALL_ACTIONS = {
  setDefaultBrowser,
  setDefaultPlayer,
};

// ─── 入口：供 index.js 调用的 step runner ─────────────────────────────────────────

export async function runSoftwareStep() {
  // 1. 询问
  const want = await confirm({
    message: '是否安装常用软件（微信 / QQ / 飞书 / PotPlayer / Chrome / SublimeText / PeaZip / NDM 等）？',
    initialValue: false,
  });
  if (!want) {
    console.log(pc.dim('已跳过软件安装。'));
    return;
  }

  // 2. 确保 winget 可用
  await ensureWinget();

  // 3. 检测已安装的软件
  let installedIds;
  const s1 = spinner();
  s1.start('正在检测已安装的软件...');
  try {
    installedIds = await detectInstalledSoftware();
    const count = installedIds.size;
    s1.stop(count > 0
      ? `检测到 ${count} 个已安装软件`
      : '未检测到已安装的目标软件');
  } catch (err) {
    s1.stop(pc.yellow(`⚠ 检测已安装软件失败: ${err.message}，将视为全部未安装`));
    installedIds = new Set();
  }

  // 4. 构建 TUI 状态并运行
  const state = createTuiState(CATALOG, installedIds);
  await runTui(state);

  if (state.confirmed === false) {
    console.log(pc.dim('用户取消软件选择。'));
    return;
  }

  // 5. 安装选中的软件
  const selected = state.allItems.filter((it) => it.selected);
  const newItems = selected.filter((it) => !it.installed);

  if (newItems.length > 0) {
    console.log(pc.cyan(`\n开始安装 ${newItems.length} 个软件...`));
    await installSoftware(selected);
  } else if (selected.length > 0) {
    console.log(pc.dim('所选软件均已安装，无需操作。'));
  } else {
    console.log(pc.dim('未选择任何软件。'));
  }

  // 6. 执行 post-install 动作
  await runPostInstallActions(selected);
}

// ─── Winget 可用性检测 & 引导安装 ────────────────────────────────────────────────

async function ensureWinget() {
  const s = spinner();
  s.start('正在检测 winget 可用性...');

  // 快速检测：winget 是否在 PATH 上可用
  const quickCheck = spawnSync('where', ['winget.exe'], {
    windowsHide: true,
    encoding: 'utf8',
  });

  if (quickCheck.status === 0 && quickCheck.stdout.trim()) {
    s.stop('✅ winget 已就绪');
    return;
  }

  s.stop(pc.yellow('⚠ winget 未安装，正在获取便携版...'));

  // ── 策略：提取 winget.exe 而非安装 msixbundle ──
  // LTSC 缺少 Store / AppX 基础设施（VCLibs、Windows App Runtime 等），
  // Add-AppxPackage 反复因依赖缺失而报 0x80073CF3。
  // 改为直接下载 msixbundle 并解包取出 winget.exe，绕开整个 AppX 安装系统。
  const tmpDir = path.join(os.tmpdir(), 'wai-winget');
  await mkdir(tmpDir, { recursive: true });

  // 1) 获取最新 winget release 的 msixbundle 下载地址
  const s2 = spinner();
  s2.start('正在获取 winget 最新版本信息...');
  let msixUrl;
  try {
    const apiRes = await fetch(
      'https://api.github.com/repos/microsoft/winget-cli/releases/latest',
      {
        headers: {
          'User-Agent': 'WindowsAfterInstall/1.0',
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!apiRes.ok) throw new Error(`GitHub API 返回 ${apiRes.status}`);
    const release = await apiRes.json();
    const asset = release.assets.find(
      (a) => a.name.endsWith('.msixbundle') && a.name.includes('8wekyb3d8bbwe'),
    );
    if (!asset) throw new Error('未在 release 中找到 msixbundle');
    msixUrl = asset.browser_download_url;
    s2.stop(`✅ 找到 winget ${release.tag_name}`);
  } catch (err) {
    s2.stop(pc.red(`❌ 获取 winget release 失败: ${err.message}`));
    throw err;
  }

  // 2) 下载 msixbundle
  const bundlePath = path.join(tmpDir, 'winget.msixbundle');
  const s3 = spinner();
  s3.start('正在下载 winget 安装包（约 100MB）...');
  try {
    await downloadLargeFile(msixUrl, tmpDir, 'winget.msixbundle');
    s3.stop('✅ 下载完成');
  } catch (err) {
    s3.stop(pc.red(`❌ 下载失败: ${err.message}`));
    throw err;
  }

  // 3) 解包：msixbundle → msix → winget.exe
  const s4 = spinner();
  s4.start('正在解包 winget...');
  const wingetDir = path.join(tmpDir, 'winget_portable');
  await mkdir(wingetDir, { recursive: true });

  const bundleExtractDir = path.join(tmpDir, 'bundle_extracted');
  const msixExtractDir = path.join(tmpDir, 'msix_extracted');

  try {
    // 3a) msixbundle 本质是 ZIP；PowerShell Expand-Archive 只认 .zip 后缀，先改名再解
    const bundleZipPath = bundlePath + '.zip';
    await renameFile(bundlePath, bundleZipPath);
    await mkdir(bundleExtractDir, { recursive: true });
    await runPowerShell(`Expand-Archive -Path '${bundleZipPath}' -DestinationPath '${bundleExtractDir}' -Force`);

    // 找到 x64 .msix（或 .appx）文件；这些也是 ZIP，同理改名
    const files = await readDir(bundleExtractDir);
    const x64Msix = files.find((f) => f.endsWith('x64.msix') || f.endsWith('x64.appx'));
    if (!x64Msix) throw new Error(`未找到 x64 包，解出文件: ${files.join(', ')}`);
    const msixPath = path.join(bundleExtractDir, x64Msix);
    const msixZipPath = msixPath + '.zip';
    await renameFile(msixPath, msixZipPath);

    // 3b) 解出 winget.exe 及所有 DLL
    await mkdir(msixExtractDir, { recursive: true });
    await runPowerShell(`Expand-Archive -Path '${msixZipPath}' -DestinationPath '${msixExtractDir}' -Force`);

    // 找到 winget.exe（可能在根目录或子目录）
    const wingetExe = await findFile(msixExtractDir, 'winget.exe');
    if (!wingetExe) throw new Error('解包后未找到 winget.exe');

    // 4) 把 winget.exe 及其所在目录的 DLL 都复制到 wingetDir
    const exeDir = path.dirname(wingetExe);
    await runPowerShell(`Copy-Item -Path '${exeDir}\\*' -Destination '${wingetDir}\\' -Recurse -Force`);
  } catch (err) {
    s4.stop(pc.red(`❌ 解包失败: ${err.message}`));
    throw err;
  }

  s4.stop('✅ 解包完成');

  // 5) 将 wingetDir 加入当前进程 PATH
  process.env.Path = `${wingetDir};${process.env.Path || ''}`;

  // 验证
  const verify = spawnSync('winget.exe', ['--version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (verify.status === 0) {
    console.log(pc.green(`✅ winget 已就绪: ${verify.stdout.trim()}`));
  } else {
    const errMsg = (verify.stderr || verify.stdout || '').toString().trim();
    console.log(pc.yellow(`⚠ winget 版本检测异常 (exit ${verify.status})，仍将尝试继续: ${errMsg}`));
  }
}

// ─── 已安装软件检测 ──────────────────────────────────────────────────────────────

async function detectInstalledSoftware() {
  // winget list 输出格式（列间以两个以上空格分隔）：
  //   名称                ID                    版本            可用            源
  //   ─────────────────────────────────────────────────────────────────────────
  //   Google Chrome       Google.Chrome         131.0.6778.140                 winget
  const result = spawnSync('winget.exe', ['list', '--accept-source-agreements'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000,
  });

  const output = (result.stdout || '').toString();
  const installedIds = new Set();

  // 收集所有 CATALOG 中的 winget ID 用于匹配
  const catalogIds = new Set();
  for (const cat of CATALOG) {
    for (const item of cat.items) {
      catalogIds.add(item.id.toLowerCase());
    }
  }

  const lines = output.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    // 检测表头分隔行
    if (line.includes('────')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      const id = parts[1].trim();
      if (catalogIds.has(id.toLowerCase())) {
        installedIds.add(id);
      }
    }
  }

  return installedIds;
}

// ─── TUI 状态 & 渲染 ─────────────────────────────────────────────────────────────

function createTuiState(catalog, installedIds) {
  const allItems = [];
  for (let ci = 0; ci < catalog.length; ci++) {
    for (const item of catalog[ci].items) {
      const installed = installedIds.has(item.id);
      allItems.push({
        ...item,
        categoryIndex: ci,
        installed,
        selected: installed,
      });
    }
  }

  return {
    catalog,
    allItems,
    activeCategory: 0,
    cursor: 0,
    confirmed: null,
    get currentItems() {
      return this.allItems.filter((it) => it.categoryIndex === this.activeCategory);
    },
    focusedItem() {
      const items = this.currentItems;
      return items[this.cursor] || null;
    },
  };
}

function renderScreen(state) {
  const lines = [];
  const cat = state.catalog[state.activeCategory];
  const items = state.currentItems;

  // 清屏 + 光标归位
  lines.push('\x1b[H\x1b[J');

  // 标题
  lines.push('  ' + pc.bold(pc.cyan('选择要安装的软件')));
  lines.push('');

  // 分类标签栏
  const tabParts = state.catalog.map((c, i) => {
    const label = `[ ${c.label} ]`;
    return i === state.activeCategory
      ? pc.bgBlue(pc.white(' ' + label + ' '))
      : pc.dim('  ' + label + '  ');
  });
  lines.push('  ' + tabParts.join(' '));
  lines.push('');

  // 软件列表
  if (items.length === 0) {
    lines.push('  ' + pc.dim('(此分类下暂无软件)'));
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isCursor = i === state.cursor;

      // 左侧复选框
      let checkbox;
      if (item.installed) {
        checkbox = pc.green('[✓]');
      } else if (item.selected) {
        checkbox = pc.cyan('[●]');
      } else {
        checkbox = pc.dim('[ ]');
      }

      // 名称 + 状态标签
      let namePart = ` ${item.name}`;
      if (item.installed) {
        namePart += pc.dim(' (已安装)');
      }

      // 光标行反色
      if (isCursor) {
        lines.push('  ' + checkbox + pc.bgWhite(pc.black(namePart)));
      } else {
        lines.push('  ' + checkbox + namePart);
      }
    }
  }

  // 底部提示
  lines.push('');
  if (state.catalog.length > 1) {
    lines.push(pc.dim('  ← → 切换分类  ↑ ↓ 移动  Space 选择/取消  Enter 确认  Esc 取消'));
  } else {
    lines.push(pc.dim('  ↑ ↓ 移动  Space 选择/取消  Enter 确认  Esc 取消'));
  }

  process.stdout.write(lines.join('\n'));
}

// ─── TUI 输入处理 ────────────────────────────────────────────────────────────────

function runTui(state) {
  return new Promise((resolve) => {
    const { stdin } = process;

    // 非 TTY 回退：全选未安装的软件
    if (!stdin.isTTY) {
      for (const item of state.allItems) {
        if (!item.installed) item.selected = true;
      }
      state.confirmed = true;
      const selectedCount = state.allItems.filter((it) => it.selected && !it.installed).length;
      console.log(pc.yellow(`非交互终端，将自动安装 ${selectedCount} 个未安装的软件。`));
      resolve(state);
      return;
    }

    const prevRaw = stdin.isRaw;

    // 保存光标并切换到替代缓冲区（防止滚动历史中残留 TUI 界面）
    process.stdout.write('\x1b[?1049h');

    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      try { stdin.setRawMode(prevRaw ?? false); } catch { /* ignore */ }
      stdin.removeListener('data', onData);
      stdin.pause();
      // 退出替代缓冲区
      try { process.stdout.write('\x1b[?1049l'); } catch { /* ignore */ }
    }

    function confirmTui() {
      state.confirmed = true;
      cleanup();
      resolve(state);
    }

    function cancelTui() {
      state.confirmed = false;
      cleanup();
      resolve(state);
    }

    function moveUp() {
      if (state.cursor > 0) {
        state.cursor--;
        renderScreen(state);
      }
    }

    function moveDown() {
      const max = state.currentItems.length - 1;
      if (state.cursor < max) {
        state.cursor++;
        renderScreen(state);
      }
    }

    function moveLeft() {
      if (state.activeCategory > 0) {
        state.activeCategory--;
        state.cursor = 0;
        renderScreen(state);
      }
    }

    function moveRight() {
      if (state.activeCategory < state.catalog.length - 1) {
        state.activeCategory++;
        state.cursor = 0;
        renderScreen(state);
      }
    }

    function toggleItem() {
      const item = state.focusedItem();
      if (item && !item.installed) {
        item.selected = !item.selected;
        renderScreen(state);
      }
    }

    function onData(data) {
      // Windows 终端上，方向键序列以单次 data 事件发送：
      //   Up:    \x1b[A  (ESC [ A)
      //   Down:  \x1b[B  (ESC [ B)
      //   Right: \x1b[C  (ESC [ C)
      //   Left:  \x1b[D  (ESC [ D)
      //   独立 Esc 发送单个 \x1b
      const str = data.toString();

      switch (str) {
        case '\x1b[A': moveUp(); return;
        case '\x1b[B': moveDown(); return;
        case '\x1b[C': moveRight(); return;
        case '\x1b[D': moveLeft(); return;
        case '\x1b':   cancelTui(); return;
      }

      // 普通字符
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          confirmTui();
          return;
        }
        if (ch === ' ') {
          toggleItem();
        }
      }
    }

    stdin.on('data', onData);
    renderScreen(state);
  });
}

// ─── 批量安装 ────────────────────────────────────────────────────────────────────

async function installSoftware(selections) {
  const toInstall = selections.filter((s) => s.selected && !s.installed);
  if (toInstall.length === 0) return;

  const failures = [];

  for (let i = 0; i < toInstall.length; i++) {
    const item = toInstall[i];

    // 打印静态标题行，winget 进度条自然显示在下方，互不覆盖
    console.log('');
    console.log(pc.cyan(pc.bold(`══ [${i + 1}/${toInstall.length}] ${item.name} (${item.id}) ══`)));

    try {
      const code = await runExecutable('winget.exe', [
        'install', '--id', item.id,
        '--exact',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ], { windowsHide: false }); // 不隐藏窗口，让 winget 进度条输出到终端

      if (code === 0) {
        console.log(pc.green(`✅ ${label}`));
      } else {
        console.log(pc.yellow(`⚠ ${label} — winget 返回退出码 ${code}，可能已安装但需重启生效`));
      }
    } catch (err) {
      const msg = `${item.name}: ${err.message}`;
      failures.push(msg);
      console.log(pc.red(`❌ ${msg}`));
    }
    console.log('');
  }

  if (failures.length > 0) {
    console.log(pc.yellow(`\n${failures.length}/${toInstall.length} 个软件安装失败，可稍后手动安装：`));
    for (const f of failures) {
      console.log(pc.dim(`  - ${f}`));
    }
  } else {
    console.log(pc.green(`\n✅ 全部 ${toInstall.length} 个软件安装完成`));
  }
}

// ─── Post-install 动作 ───────────────────────────────────────────────────────────

async function runPostInstallActions(selections) {
  for (const item of selections) {
    if (!item.selected) continue;
    if (!item.postInstall) continue;

    const action = POST_INSTALL_ACTIONS[item.postInstall];
    if (!action) continue;

    const s = spinner();
    s.start(`正在将 ${item.name} 设为默认程序...`);
    try {
      await action();
      s.stop(pc.green(`✅ ${item.name} 已设为默认程序`));
    } catch (err) {
      s.stop(pc.yellow(`⚠ ${item.name} 默认程序设置失败: ${err.message}`));
    }
  }
}

/**
 * 将 Chrome 设为默认浏览器。
 * 方法：启动 Chrome 的 --make-default-browser 参数。
 * 在 Windows 10+ 上此操作会弹出系统设置页面，用户可手动确认。
 */
async function setDefaultBrowser() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  let found = null;
  for (const p of candidates) {
    if (await fileExists(p)) {
      found = p;
      break;
    }
  }
  if (!found) {
    throw new Error('未找到 Chrome 安装路径');
  }

  // --make-default-browser 会在 Windows 10+ 打开设置页面
  await runExecutable(found, ['--make-default-browser'], {
    windowsHide: true,
  });
}

/**
 * 将 PotPlayer 设为默认播放器。
 * 方法：调用 PotPlayer 的 /RegisterAll 注册所有文件关联。
 */
async function setDefaultPlayer() {
  // 1) 先试 where（winget 安装后通常在 PATH 上）
  const whereR = spawnSync('where', ['PotPlayerMini64.exe', 'PotPlayer64.exe', 'PotPlayer.exe'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (whereR.status === 0 && whereR.stdout.trim()) {
    const found = whereR.stdout.trim().split(/\r?\n/)[0].trim();
    await runExecutable(found, ['/RegisterAll'], { windowsHide: true });
    return;
  }

  // 2) 搜索常见安装目录
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const names = ['PotPlayerMini64.exe', 'PotPlayer64.exe', 'PotPlayer.exe'];

  for (const base of [pf, pf86]) {
    for (const sub of ['DAUM\\PotPlayer', 'PotPlayer']) {
      for (const name of names) {
        const p = path.join(base, sub, name);
        if (await fileExists(p)) {
          await runExecutable(p, ['/RegisterAll'], { windowsHide: true });
          return;
        }
      }
    }
  }

  // 3) 找不到则不抛错，给用户手动提示
  throw new Error(`未找到 PotPlayer 安装路径。请手动打开 PotPlayer → 选项(F5) → 关联 → 点击"全部关联"`);
}

// ─── 通用工具 ────────────────────────────────────────────────────────────────────

/**
 * 下载大文件：优先使用 aria2c（多线程加速），失败则回退到 Node.js fetch。
 * aria2c 在内网/代理环境下可能 SSL 握手失败，fetch 使用系统 TLS 栈兼容性更好。
 */
async function downloadLargeFile(url, dir, outName) {
  // 1) 尝试 aria2c
  try {
    await aria2Download(url, dir, {
      out: outName,
      connections: 16,
    });
    return;
  } catch (ariaErr) {
    console.log(pc.dim(`  aria2c 下载失败: ${ariaErr.message}，回退到 Node.js fetch...`));
  }

  // 2) 回退 Node.js fetch（单线程，但使用系统 TLS，兼容性更好）
  const dest = path.join(dir, outName);
  // 删除 aria2c 残留的控制文件
  const aria2cControlFile = dest + '.aria2';
  await rm(aria2cControlFile, { force: true }).catch(() => {});

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadFile(url, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        console.log(pc.dim(`  fetch 下载失败: ${err.message}，第 ${attempt + 2}/3 次重试...`));
        await sleep(3000);
      }
    }
  }
  throw lastErr;
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const file = createWriteStream(dest);
  await finished(Readable.fromWeb(res.body).pipe(file));
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 重命名文件，目标已存在则先删除（Windows rename 不支持覆盖）。 */
async function renameFile(oldPath, newPath) {
  await rm(newPath, { force: true }).catch(() => {});
  await rename(oldPath, newPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 执行一段 PowerShell（同步，非零退出抛错）。 */
function runPowerShell(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(err || `PowerShell 退出码 ${r.status}`);
  }
  return r;
}

/** 列出目录中的文件（非目录）。 */
function readDir(dirPath) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-ChildItem -Path '${dirPath}' -File -Name) -join "\n"`,
  ], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  if (r.status !== 0) return [];
  return (r.stdout || '').toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 递归搜索 dirPath 下指定文件名，返回完整路径，未找到返回 null。 */
function findFile(dirPath, name) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-ChildItem -Path '${dirPath}' -Recurse -Filter '${name}' -File | Select-Object -First 1).FullName`,
  ], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  if (r.status !== 0) return null;
  const result = (r.stdout || '').toString().trim();
  return result || null;
}
