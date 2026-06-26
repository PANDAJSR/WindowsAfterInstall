import { execSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const binDir = path.join(root, 'bin', 'sdio');
const zipPath = path.join(binDir, 'sdio.zip');
const PAGE = 'https://www.glenn.delahoy.com/snappy-driver-installer-origin/';
const BASE = 'https://www.glenn.delahoy.com';

await mkdir(binDir, { recursive: true });

// 从官方页面抓取最新 SDIO_x.y.z.b.zip 下载链接
console.log(`查询最新 SDIO: ${PAGE}`);
const html = execSync(`curl -sL "${PAGE}"`, { encoding: 'utf8' });
const m = html.match(/\/downloads\/sdio\/SDIO_[0-9]+(?:\.[0-9]+)+\.zip/i);
if (!m) {
  throw new Error('未能在官方页面找到 SDIO 下载链接，请检查网络或手动下载。');
}
const url = BASE + m[0];
const ver = path.basename(m[0]).replace(/\.zip$/i, '');
console.log(`最新版本: ${ver}`);
console.log(`下载: ${url}`);

execSync(`curl -sL -o "${zipPath}" "${url}"`, { stdio: 'inherit' });

// 校验 zip 魔数 (PK\x03\x04)
const fd = openSync(zipPath, 'r');
const head = Buffer.alloc(4);
readSync(fd, head, 0, 4, 0);
closeSync(fd);
if (head.toString('hex') !== '504b0304') {
  throw new Error(`下载的文件不是有效的 zip: ${zipPath}`);
}

console.log(`✅ SDIO 已就绪: ${zipPath} (${(await stat(zipPath)).size} bytes)`);
