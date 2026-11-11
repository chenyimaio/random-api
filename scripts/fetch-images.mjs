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
const TAR_NAME = `images-${BRANCH}.tar.gz`;

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
  mkdirSync(tmp, { recursive: true });
  mkdirSync(IMG_DIR, { recursive: true });

  const tarballPath = join(tmp, TAR_NAME);
  // curl 下载（-sL 静默跟随重定向；--fail 出错时非零退出；--retry 3 网络抖动重试）
  execSync(`curl -sL --fail --retry 3 -o "${tarballPath}" "${TARBALL}"`, { stdio: 'inherit' });

  // 解压到临时目录
  execSync(`tar -xzf "${tarballPath}" -C "${tmp}"`, { stdio: 'inherit' });

  // 解压出来是 <repo>-<branch>/ 目录，把里面的内容复制进 public/img
  const extracted = join(tmp, `${REPO.split('/')[1]}-${BRANCH}`);
  if (!existsSync(extracted)) {
    console.error('[fetch-images] 解压目录不存在：' + extracted);
    process.exit(1);
  }

  // 清空 public/img 后复制（避免残留）
  rmSync(IMG_DIR, { recursive: true, force: true });
  mkdirSync(IMG_DIR, { recursive: true });
  execSync(`cp -r "${extracted}/." "${IMG_DIR}/"`, { stdio: 'inherit' });

  const count = execSync(`find "${IMG_DIR}" -type f | wc -l`).toString().trim();
  console.log(`[fetch-images] 完成，public/img 共 ${count} 个文件`);

  // 清理临时文件
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('[fetch-images] 下载失败：', e.message);
  console.error('[fetch-images] 提示：本地开发可先手动跑一次下载，或在有图片的机器上构建。');
  process.exit(1);
});
