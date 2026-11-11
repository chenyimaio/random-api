#!/usr/bin/env node
// scripts/fetch-images.mjs
// 构建时从图片仓库 random-api-images 下载图片到 public/img。
//
// 图片本体放在独立仓库，代码仓库保持轻量（clone 快、构建快）。
// EdgeOne 构建时跑这个脚本，把图片拉下来放进 public/img，最终作为静态资源部署，
// 这样用户访问图片走 EdgeOne 静态层（同域、快），不经过函数 fetch GitHub。
//
// 本地开发时 public/img 已有图片就跳过，不会每次都重新下载。
//
// 下载源：GitHub codeload tarball（一次下载整个仓库，比逐个 raw 请求快得多）。
// 解压用系统 tar（EdgeOne 构建机是 Linux）。

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const IMG_DIR = join(ROOT, 'public', 'img');

const REPO = process.env.IMAGE_REPO || 'chenyimaio/random-api-images';
const BRANCH = process.env.IMAGE_BRANCH || 'main';
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;

function hasImages() {
  if (!existsSync(IMG_DIR)) return false;
  try {
    const entries = readdirSync(IMG_DIR).filter((d) => !d.startsWith('.'));
    // 有子目录（pc/dm、mobile/dm 等）且里面有文件才算有图片
    for (const d of entries) {
      const sub = join(IMG_DIR, d);
      try {
        if (readdirSync(sub).some((f) => !f.startsWith('.'))) return true;
      } catch { /* 不是目录，跳过 */ }
    }
  } catch { /* 目录读不了，当没有 */ }
  return false;
}

async function main() {
  // 本地已有图片就跳过下载
  if (hasImages()) {
    console.log('[fetch-images] public/img 已有图片，跳过下载');
    return;
  }

  console.log('[fetch-images] public/img 为空，从图片仓库下载 …');
  console.log(`[fetch-images]   ${TARBALL}`);

  const tmp = '/tmp/random-api-images';
  rmSync(tmp, { recursive: true, force: true });
  rmSync(IMG_DIR, { recursive: true, force: true });
  mkdirSync(IMG_DIR, { recursive: true });

  // 流式下载 + 解压直接进 public/img：curl | tar 管道，tarball 不落盘，
  // --strip-components=1 去掉解压出来的顶层目录（<repo>-<branch>/）。
  // 不经过 /tmp（/tmp 和 /dev/shm 可能是不同文件系统，跨文件系统 mv 会退化成复制、占双份空间）。
  // 构建机磁盘是 /dev/shm（内存文件系统），任何中间副本都会直接 ENOSPC。
  execSync(`curl -sL --fail --retry 3 "${TARBALL}" | tar -xz --strip-components=1 -C "${IMG_DIR}"`, { stdio: 'inherit', maxBuffer: 64 * 1024 * 1024 });

  const count = execSync(`find "${IMG_DIR}" -type f | wc -l`).toString().trim();
  console.log(`[fetch-images] 完成，public/img 共 ${count} 个文件`);
}

main().catch((e) => {
  console.error('[fetch-images] 下载失败：', e.message);
  console.error('[fetch-images] 提示：本地开发可先手动跑一次下载，或在有图片的机器上构建。');
  process.exit(1);
});
