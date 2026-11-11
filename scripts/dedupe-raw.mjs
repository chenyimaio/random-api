#!/usr/bin/env node
// scripts/dedupe-raw.mjs
// 按文件内容（sha256）规范化 raw-img 下四类目录：
//   - 删除内容重复的文件（不同源抓到同一张图时文件名不同但内容一样）
//   - 重建 .manifest.json，键为完整 sha256，值记录来源
// 之后 fetch-remote.mjs 会按"文件数 < 1000"继续补，且不会再把已删的哈希当已存在。
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.argv[2] || process.cwd();
const CLASSES = (process.argv[3] || 'pc/dm,mobile/dm,pc/fjbz,mobile/fjbz').split(',').filter(Boolean);
const RAW = join(ROOT, 'raw-img');
const sha = (b) => createHash('sha256').update(b).digest('hex');

for (const cls of CLASSES) {
  const dir = join(RAW, cls);
  let files;
  try { files = readdirSync(dir).filter((f) => !f.startsWith('.')); } catch { console.log(`  ${cls.padEnd(14)} 目录不存在，跳过`); continue; }

  const seen = new Map();
  let removed = 0;
  for (const f of files) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const buf = readFileSync(p);
    const h = sha(buf);
    if (seen.has(h)) { unlinkSync(p); removed++; continue; }
    seen.set(h, { file: f, bytes: buf.length });
  }
  const manifest = {};
  for (const [h, v] of seen) manifest[h] = { file: v.file, bytes: v.bytes };
  writeFileSync(join(dir, '.manifest.json'), JSON.stringify(manifest), 'utf8');
  console.log(`  ${cls.padEnd(14)} 保留 ${seen.size} 张  (删重复 ${removed})`);
}
