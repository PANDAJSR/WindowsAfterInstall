import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const aria2Exe = path.join(root, 'bin', 'aria2', 'aria2c.exe');
const sdioZip = path.join(root, 'bin', 'sdio', 'sdio.zip');
const seaConfigPath = path.join(buildDir, 'sea-config.json');
const blobPath = path.join(buildDir, 'wai.blob');
const exePath = path.join(buildDir, 'wai.exe');

async function main() {
  console.log('开始构建自包含 exe...');

  await stat(aria2Exe).catch(() => {
    throw new Error(`找不到 aria2c.exe，请先运行 pnpm run fetch:aria2`);
  });
  await stat(sdioZip).catch(() => {
    throw new Error(`找不到 SDIO zip，请先运行 pnpm run fetch:sdio`);
  });

  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });

  // 1. bundle JS to a single file using esbuild (CJS — SEA 入口走 embedderRunCjs)
  const bundleOut = path.join(buildDir, 'bundle.cjs');
  const entry = process.env.WAI_ENTRY
    ? path.resolve(root, process.env.WAI_ENTRY)
    : path.join(root, 'src', 'index.js');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: bundleOut,
    external: [],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  // 2. generate SEA config with aria2 + sdio assets
  const seaConfig = {
    main: bundleOut,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {
      'aria2c.exe': aria2Exe,
      'sdio.zip': sdioZip,
    },
  };
  await writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  // 3. generate SEA blob
  const { execSync } = await import('node:child_process');
  execSync(`node --experimental-sea-config ${seaConfigPath}`, {
    stdio: 'inherit',
    cwd: root,
  });

  // 4. copy node executable to build dir
  const nodeExe = process.execPath;
  await copyFile(nodeExe, exePath);

  // 5. inject blob into the copied executable using postject
  const { inject } = await import('postject');
  await inject(exePath, 'NODE_SEA_BLOB', await readFile(blobPath), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA',
  });

  console.log(`✅ 自包含 exe 已生成: ${exePath}`);
  console.log(`   体积: ${(await stat(exePath)).size} bytes`);
  console.log('   可以将此 exe 拷贝到目标机器运行，无需安装 Node.js 。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
