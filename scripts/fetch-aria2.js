import { execSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const binDir = path.join(root, 'bin', 'aria2');

await rm(binDir, { recursive: true, force: true });
await mkdir(binDir, { recursive: true });

const repo = 'aria2/aria2';
const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
console.log(`查询最新 release: ${releaseUrl}`);

const res = execSync(`curl -L -s -H "Accept: application/vnd.github+json" "${releaseUrl}"`, {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
const release = JSON.parse(res);
const version = release.tag_name.replace('release-', '');

const asset = release.assets.find((a) =>
  a.name.includes('win-64bit') && a.name.endsWith('.zip')
);
if (!asset) {
  throw new Error(`未在 release ${release.tag_name} 中找到 win-64bit zip 资产`);
}

const tmpDir = path.join(root, 'tmp');
await mkdir(tmpDir, { recursive: true });
const zipPath = path.join(tmpDir, asset.name);

console.log(`下载 aria2 ${version}: ${asset.browser_download_url}`);
execSync(`curl -L -o "${zipPath}" "${asset.browser_download_url}"`, { stdio: 'inherit' });

execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' });

const extracted = path.join(tmpDir, asset.name.replace('.zip', ''), 'aria2c.exe');
await rename(extracted, path.join(binDir, 'aria2c.exe'));

console.log(`✅ aria2c ${version} 已准备好: ${path.join(binDir, 'aria2c.exe')}`);
await rm(tmpDir, { recursive: true, force: true });
