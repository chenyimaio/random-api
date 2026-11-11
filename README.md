# random-api

> **许可：AGPL-3.0。** 本仓库打包了 [hitokoto-osc/sentences-bundle](https://github.com/hitokoto-osc/sentences-bundle)
> 的句子（该库为 AGPL-3.0）。由于我们把句子下载并打进了服务端产物、通过网络对外提供，
> 整个项目需按 AGPL-3.0 授权，并向网络用户提供完整源码 —— 本仓库即源码地址。
> 详见 [NOTICE.md](./NOTICE.md) 与 [LICENSE](./LICENSE)。
> 只想用一言、不想被 AGPL 传染，请改用上游官方的**超链接调用方式**（运行时请求
> `https://v1.hitokoto.cn/`），不要把句子包打进自己的产物。

随机图片 + 一言 API。**数据和代码在同一个仓库里**，没有数据库、没有外部依赖、没有第三方服务。

- 一言：**约 10.6 千句（全量）** —— 50 条手工挑的古典诗词 +
  [hitokoto-osc/sentences-bundle](https://github.com/hitokoto-osc/sentences-bundle) 的
  12 个分类全量（抓到 11,266 条、按正文去重后 10,605 条），
  GitHub Actions 每天自动同步上游更新
- 图片：**4000 张**，按四类路径组织，每张出 **AVIF（无损）/ WebP 两份**：
  `pc/dm` 电脑二次元 1000 · `mobile/dm` 手机二次元 1000 ·
  `pc/fjbz` 电脑风景 1000 · `mobile/fjbz` 手机风景 1000
- 按设备自适应 + 按题材过滤：默认 `dm`（二次元），可切 `fjbz`（现实风景照）；
  电脑给横图、手机给竖图。也支持简短路径 `/pc/dm`、`/mobile/fjbz` 等
- 按格式协商：产物为 AVIF（无损）/ WebP 两份；接口仍兼容 `?format=jpeg` 等参数并优雅回退，
  也支持 PNG / GIF / BMP / TIFF / HEIC / HEIF 等输入格式
- 运行时零依赖；构建时只用 esbuild 打一个单文件

**画质阶梯：AVIF 无损 > WebP 有损。**
AVIF 走 `lossless=True`，不引入第二次压缩损失；实测对这批二次元图反而比有损 q90 更小。WebP 保持 q82，作为兼容性最好的默认格式。

当前产物体积：WebP **843 MB** + AVIF（无损）**880 MB** = **1.68 GB** / 8000 个文件。

---

## 快速开始

```bash
npm install
python -m pip install pillow pillow-heif   # pillow-heif 用于 HEIC/HEIF 输入
npm run img        # 把 raw-img/ 的原图压成 WebP + AVIF、按横竖分类
npm run build      # 扫索引 + 打包到 cloud-functions/[[default]].js
npm run dev        # http://127.0.0.1:8790
```

打开首页能看到随机一言和随机图片；可选题材（二次元/风景）、设备（自动/电脑/手机）、格式。

跑测试：

```bash
npm test           # 65 项，直接打接口，不需要起服务器
```

---

## 接口

全部 `GET`，全部允许跨域，随机接口 `cache-control: no-store`。

| 路径 | 说明 |
|---|---|
| `/api/hitokoto` | 一言，字段对齐 [hitokoto](https://hitokoto.cn/) 的 JSON 形状，现成组件可直接用 |
| `/api/daily` | **每日一句**：同一天所有人拿到同一句，跨天自动换，带一天缓存头 |
| `/api/quote` | 一言简版：`{ quote, from, fromWho, type }` |
| `/api/quotes?n=5` | 批量随机，不重复；`n` 超过数据量时截断 |
| `/api/image` | 图片信息：`{ url, width, height, orientation, format, formats, bytes }` |
| `GET /api/random` | **302** 跳到图片本身，可直接写进 `<img src>`；响应头带 `x-image-orientation`、`x-image-format`。支持 `?orientation=`、`?format=` |
| `/api/all` | 一言 + 图片一起返回 |
| `/api/images` | 全部图片 + 各朝向/各格式数量 |

### 每日一句

```
GET /api/daily                 # 今天的
GET /api/daily?tz=Asia/Shanghai # 按上海时间算"今天"
GET /api/daily?date=2026-03-15  # 回看某一天
GET /api/daily?type=a           # 只在动画分类里挑
```

```json
{
  "id": 1351,
  "uuid": "qa-001351",
  "hitokoto": "纵使天光终将熄灭，我们也要歌颂太阳。",
  "type": "a", "from": "...", "from_who": null,
  "date": "2026-11-10",
  "timezone": "UTC",
  "nextUpdate": "2026-11-10T23:59:59.318Z",
  "daily": true
}
```

响应头：

```
cache-control: public, max-age=40039      ← 到该时区下一个零点的秒数
etag: "daily-2026-11-10-1351"
```

三条性质：

- **同一天固定**：所有人、所有次数、所有设备拿到同一句
- **跨天必变**：用「日期天数 × 与池子大小互质的步长」取模，
  连续 `count` 天不会重复任何一句（实测连续 60 天零重复）
- **可回看**：`?date=2026-03-15` 永远返回那天的那句

为什么不用 `sha256(日期) % 句子数`：那个除数一变（加了几句话），整月的排期就全乱，
用户会发现"昨天的句子今天变了"。现在的做法只依赖日期，改数据只影响增量。

### 随机数

```
GET /api/number                                  # → 0..100 之间的一个整数
GET /api/number?min=1&max=6                      # 掷骰子
GET /api/number?n=5&min=1&max=100                # 一次给 5 个
GET /api/number?n=6&min=1&max=6&unique=1         # 不重复（抽奖/洗牌）
GET /api/number?min=0&max=1&decimals=3           # 小数
```

```json
{ "number": 42, "min": 0, "max": 100, "type": "int", "unique": false }
{ "numbers": [8,33,63,1,56], "count": 5, "min": 1, "max": 100, "type": "int", "unique": false }
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `min` / `max` | `0` / `100` | 闭区间；`min == max` 时恒等 |
| `n` | `1` | 个数，上限 1000 |
| `unique` | `false` | 去重；去重个数不能超过区间跨度 |
| `decimals` | 不传 | 传了就是小数，保留几位（0–10） |

大跨度去重（如 `min=0&max=1000000000&n=5`）不会建十亿元素的数组：
跨度不超过 10 万时用部分 Fisher-Yates，超过就换成拒绝采样。

### 随机字符串

```
GET /api/string                                             # 16 位，小写+大写+数字
GET /api/string?length=32&symbols=1&underscore=1            # 加上符号和下划线
GET /api/string?length=20&lower=0&upper=0&digits=1&symbols=0  # 纯数字
GET /api/string?length=32&noAmbiguous=1                     # 去掉 0O1lI| 这类易混字符
GET /api/string?length=16&exclude=abcXYZ019                 # 自定义排除
GET /api/string?n=5&length=24                               # 一次 5 个
```

```json
{
  "string": "U6EiVG58E[N6Eva(~:r|UB@A3J05_Y4k",
  "length": 32,
  "classes": ["lower", "upper", "digits", "symbols", "underscore"]
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `length` | `16` | 1–512。**可以给列表**：`8,12,16` |
| `n` | 长度列表的个数或 1 | 串数，上限 100 |
| `chars` | 无 | **完全自定义字符池**，给了就忽略类开关 |
| `lower` / `upper` / `digits` | 开 | 小写 / 大写 / 数字 |
| `symbols` | 关 | 开关，或直接给字符集（`symbols=!@#`） |
| `underscore` | 关 | `_` |
| `minDigits` / `minSymbols` / `minUpper` / `minLower` | 每类各 1 | **该类的字符至少出现几次** |
| `exclude` | 无 | 要去掉的字符（≤128 个） |
| `noAmbiguous` | 关 | 剔除 `0O1lI|` 等易混字符 |

长度可以是一串：

```
/api/string?length=8,12,16        → 三个串，长度依次 8 / 12 / 16
/api/string?length=8,12&n=5       → 五个串，长度按 8,12,8,12,8 循环
```

字符集可以完全自己定，不用挑预设：

```
/api/string?length=32&chars=abc123              → 只用 a b c 1 2 3
/api/string?length=16&chars=01                  → 二进制串
/api/string?length=20&symbols=!@#               → 自带符号集
/api/string?length=20&chars=abcdef&exclude=abc  → 只剩 def
/api/string?length=10&chars=🏀⚽                 → 多字节字符按"字符数"计，不是码元
```

`chars` 给什么就用什么（`exclude` / `noAmbiguous` 仍会再过一遍）。
长度按**字符数**算，emoji 这类代理对算 1 个。

### 口令生成器用法（对应页面上那套选项）

```
/api/string?length=14&upper=1&lower=1&digits=1&symbols=0&minDigits=1
/api/string?length=16&symbols=!@#$%^&*&minSymbols=3
/api/string?length=20&noAmbiguous=1
```

| 页面选项 | 对应参数 |
|---|---|
| 长度 | `length` |
| 包含 A-Z / a-z / 0-9 | `upper=1` / `lower=1` / `digits=1` |
| 包含 !@#$%^&* | `symbols=!@#$%^&*`（值是字符集，不是开关） |
| 数字最少个数 | `minDigits=N` |
| 特殊字符最少个数 | `minSymbols=N` |
| 避免易混淆的字符 | `noAmbiguous=1` |

下限之和超过长度会返回 400，并在 `message` 里给出具体数字：

```json
{"error":"invalid_parameter","message":"sum of minimums (11) exceeds length (8)"}
```

用 `chars=` 自定义字符集时，池子里没有的类会被自动跳过；
只有你**明确**要求了某类的下限、而池子里恰好没有这类字符时才会报错。

两个质量保证：

- **开了哪类就一定有哪类**。只要 `length >= 启用的类数`，结果里每类至少出现一次
  （纯随机会出现「开了符号却一个符号都没有」的口令，不合规）
- **先塞后洗**。各类先各占一位，再整体 Fisher-Yates 洗牌，所以位置也没有规律

---

## 随机性是怎么保证的

**全项目只有一个随机源：`src/entropy.js`**，底层是 `node:crypto` 的 `randomInt` / `randomBytes`。

| 做法 | 原因 |
|---|---|
| 不用 `Math.random()` | V8 的 xorshift128+ 只有 64 位种子，拿到几个连续输出就能反推状态、预测后续全部值 |
| 启动即自检 | 缺 `crypto` 时**直接抛错**，绝不静默退回弱随机 |
| 拒绝采样而非取模 | `randomInt(n)` 内部拒绝采样，`x % n` 会有可测量的取模偏差 |
| 小数用 53 位拼接 | 不用浮点乘加，避免精度损失带来的偏差 |
| 超 2^48 的区间自己拼字节 | Node 的 `randomInt` 有上限，超了要另行拒绝采样 |
| 响应一律 `no-store` | 被 CDN 缓存住的话，所有人拿到同一个"随机"值 |

测试里带了统计检验，不是靠"看起来随机"：

```
卡方均匀性检验通过（chi²=8.48 < 27.9，df=9）      ← 1..10 各 5000 次
字符串字符分布无极端偏斜（最差偏差 22.4%）        ← 200 × 40 字符
连续 50 次取值互不相同
全项目只有一个随机源（entropy.js），没有 Math.random
```

> 严格说，云函数里拿不到硬件噪声源，用的是操作系统 CSPRNG（`getrandom`）——
> 它是密码学安全的伪随机，但**不可预测**：读到进程全部内存也推不出下一个输出。
> 这正是 TLS、SSH、密码学库的同一套来源。
> 需要警惕的是 `Math.random()` 那类可预测的假随机，本项目一次都没用。
### 图片格式协商

每张图离线生成两份：**AVIF（无损）/ WebP（默认）**。两种方式选择，`?format=` 优先：

| 请求 | 拿到什么 |
|---|---|
| `Accept: image/avif,image/webp,*/*`（现代浏览器） | **AVIF** |
| `Accept: image/webp,*/*`（只支持 WebP） | **WebP** |
| `Accept: image/jpeg`（老客户端） | **WebP**（JPEG 层已下线，顺链回退） |
| `Accept: */*` 或没有 `Accept` | 默认 **WebP** |
| `?format=avif` / `webp` | 指定的格式（要 `jpeg` 会回退到 webp） |

**缺格式时的回退链：`avif → webp`**

| 情况 | 结果 |
|---|---|
| 要 avif，这张图没有 | → WebP |
| 要 avif，这张图没有 | → WebP |
| 要 jpeg（已下线） | → WebP（默认），**不会**给 AVIF |
| 要 `heic`（根本不产出的格式） | → WebP，并标 `requestedFormat: "heic"` |

回退**只往兼容性更高的方向走**。反过来（要 JPEG 却给 AVIF）等于假设客户端能解 AVIF，
而它主动要 JPEG 恰恰说明它可能解不了。

> **用 `fetch()` 拿图时要注意 Accept。**
> `fetch()` 默认发 `Accept: */*`，不是浏览器的图片支持列表，所以后端看不出它能不能解 AVIF，
> 会按默认给 WebP。想让它按能力协商，得自己声明：
>
> 探测 AVIF 要用**真实图片解码**，不能用 `canvas.toDataURL('image/avif')` ——
> 后者测的是「编码」能力，Chrome 的 canvas 编码器不支持 AVIF 时会静默回退 PNG，
> 于是支持 AVIF 的浏览器也会被误判成不支持，默认一直给 WebP。
>
> ```js
> // 1×1 真实 AVIF，可直接内嵌（约 300 字节）
> const AVIF_DATA = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAGgAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAIm1kYXQSAAoFGAAGBCAyDxgACiiihAAAsBNTexjLzg==';
> let avifOk = true;                       // 乐观默认
> const probe = new Image();
> probe.onload = () => { avifOk = probe.naturalWidth === 1; };
> probe.onerror = () => { avifOk = false; };
> probe.src = AVIF_DATA;
>
> // 探测是异步的：结论翻转后要把"自动"档重拉一次
> fetch('/api/image', {
>   headers: { accept: avifOk ? 'image/avif,image/webp,*/*' : 'image/webp,*/*' },
> }).then(r => r.json());
> ```
>
> 用 `<img src="/api/random">` 则不用操心 —— 浏览器本来就会带真实 Accept，自动就是最优格式。
> 本项目演示页用的就是上面这套解码探测。

几个刻意的选择：

- **通配不等于点名**。`Accept: image/webp,*/*` 不会拿到 AVIF —— 否则只支持 WebP 的客户端会被塞一个它解不了的格式。
- **一定给得出来**。请求的格式不存在就按链回退，不会 404；响应带 `x-format-fallback` 说明发生了回退。
- **302 带 `Vary: Accept`**。同一个 URL 会因为 `Accept` 不同返回不同格式，不加这个头会被 CDN 缓存串味。

### 透明通道

PNG 之类的透明图，**WebP 和 AVIF 都会保留 alpha**（两者的规范都支持）。

- 调色板 PNG（P 模式）的透明信息存在 `info['transparency']` 里，
  `getbands()` 只会返回 `('P',)` —— 只按 mode 判断会把这类图的透明通道丢掉
- 不透明的图仍按 RGB 编码，不会白白多一个 alpha 通道

> 自测方法：丢一张透明 PNG 进 `raw-img/`，`npm run img` 后
> `python -c "from PIL import Image; print(Image.open('xxx.webp').mode)"` 应输出 `RGBA`。

### 朝向与类别自适应

| 请求 | 拿到什么 |
|---|---|
| `/api/random`（不带参数） | 按 UA：手机 → 竖图（mobile/dm），电脑/平板 → 横图（pc/dm） |
| `?genre=fjbz` | 风景类；电脑自动解析成 `pc/fjbz`，手机解析成 `mobile/fjbz` |
| `?device=mobile` | 竖图类，自动补 `dm` → `mobile/dm` |
| `?class=pc/dm` | 强制该类（压过 UA） |
| `?orientation=landscape` / `portrait` | 显式朝向，优先级最高 |
| `/pc/dm`、`/mobile/fjbz` 等短路径 | 等价于 `/api/random?class=...`，直接返回图片字节 |

**四类**（`dm` = 二次元，`fjbz` = 现实风景照），各 1000 张：

| 路径 | 内容 | 朝向 |
|---|---|---|
| `/pc/dm` | 电脑二次元 | 横 |
| `/mobile/dm` | 手机二次元 | 竖 |
| `/pc/fjbz` | 电脑风景壁纸 | 横 |
| `/mobile/fjbz` | 手机风景壁纸 | 竖 |

过滤不到图时会优雅退回全部，不会突然 404。
响应里的 `orientation` 是图片自身朝向，`requestedOrientation` 是这次的意图，
`class` / `device` / `genre` 回显命中的类别。

过滤参数：

```bash
curl 'https://你的域名/api/hitokoto?type=d'
curl 'https://你的域名/api/image?orientation=portrait&format=avif'
curl 'https://你的域名/api/random?orientation=landscape'
```

### 嵌入示例

```html
<!-- 随机图片：手机自动拿竖图、电脑拿横图，浏览器支持 AVIF 就拿 AVIF -->
<img src="https://你的域名/api/random" alt="">

<!-- 强制竖图 + AVIF -->
<img src="https://你的域名/api/random?orientation=portrait&format=avif" alt="">

<!-- 随机一言 -->
<script>
fetch('https://你的域名/api/hitokoto')
  .then(r => r.json())
  .then(d => { document.body.append(`「${d.hitokoto}」 ${d.from}`); });
</script>
```

### 为什么图片用 302 而不是直接吐字节

图片由静态层提供，函数只负责「指路」。这样带宽不经过函数，也不会撞上 Cloud Functions
的响应体上限（约 6 MB）和超时限制。

---

## 图片处理流程

```
raw-img/                      原始素材，常见格式都支持（见下）
   │  npm run img             optimize-images.py：
   │                          按 EXIF 摆正 → 转 AVIF(无损)+WebP → 缩尺寸 → 剥元数据 → 按类别分目录
   ▼
public/img/pc/dm/*.{avif,webp}         电脑二次元横图
public/img/mobile/dm/*.{avif,webp}     手机二次元竖图
public/img/pc/fjbz/*.{avif,webp}       电脑风景横图
public/img/mobile/fjbz/*.{avif,webp}   手机风景竖图
   │  npm run gen             扫目录、读文件头拿宽高、按 stem 合并同一张图的多种格式
   ▼
data/images.json              索引（class / device / genre / orientation / width / height / formats）
```

### 支持的输入格式

| 格式 | 扩展名 | 说明 |
|---|---|---|
| JPEG | `.jpg` `.jpeg` `.jfif` | 读 EXIF 方向并自动摆正（**输入**；产物不再生成 jpg） |
| PNG | `.png` | 保留透明通道 |
| WebP | `.webp` | |
| AVIF | `.avif` | |
| GIF | `.gif` | 只取首帧 |
| BMP / TIFF | `.bmp` `.tif` `.tiff` | 体积大，转完差异很大 |
| **HEIC / HEIF** | `.heic` `.heif` `.hif` | 需要 `pip install pillow-heif`；iPhone 默认拍照格式 |
| 其他 | — | Pillow 能读的都行，读不了会逐条报错而不是静默跳过 |

### 加图片

```bash
cp ~/DCIM/IMG_1234.HEIC raw-img/
npm run img        # 压成 AVIF(无损) + WebP 并分类
npm run build      # 重建索引 + 打包
```

`raw-img/` 在 `.gitignore` 里 —— 只提交压缩后的产物，仓库不会被原图撑爆。

### 一言全量与自动同步

句子用**上游全量**（12 个分类，不去重过滤长度），不是抽样。

```bash
npm run sync:sentences                 # 有更新才写；--force 强制重写
```

`.github/workflows/sync-sentences.yml` 每天 **UTC 02:00（北京时间 10:00）** 自动跑：

1. 读上游 `version.json` 的 `bundle_version`，和本地 `data/sentences-version.json` 比对
2. 未变 → 直接跳过，**不产生空提交**
3. 有变 → 并行拉 12 个分类 → 按正文去重 → 写 `data/quotes.remote.json`
4. `npm run gen && npm run build` 重建索引与函数产物（数据会被内联进去）
5. 跑 `npm test`，通过后以 `github-actions[bot]` 提交并推送

也可以在 Actions 页面手动 `Run workflow`，勾 `force` 强制重拉。

> 上游是 AGPL-3.0，本仓库整体同协议，见 [NOTICE.md](./NOTICE.md)。

### 批量抓取图片素材

```bash
node scripts/fetch-remote.mjs                          # 图片 400 张（不拉句子）
node scripts/fetch-remote.mjs --images 400 --only mp   # 只补手机竖图
node scripts/fetch-remote.mjs --images 0              # 不拉图片
```

> 句子已改为由 `sync-sentences` 全量同步，`fetch-remote.mjs` 里的句子抓取仅作历史保留。

| 项 | 说明 |
|---|---|
| 图片来源 | 二次元：`t.alcy.cc`（pc/moez/mp）、`api.loliapi.com`、`uapis.cn`（category=acg）；风景：`uapis.cn`（category=landscape）、`picsum.photos`（真实风景照） |
| 去重 | 图片按 sha256，句子按正文 |
| 校验 | 按文件头判断真实格式，拿 HTML 错误页冒充图片的会被拒 |
| 礼貌 | 并发 4、请求间隔 120 ms、超时 30 s、失败重试 3 次 |
| 断点 | `raw-img/remote/.manifest.json` 记录已拉过的哈希，重复跑不会重复下载 |

句子写到 `data/quotes.remote.json`，和手工挑的 `data/quotes.json` **分开存** ——
重跑抓取不会覆盖你自己的那批，构建时再合并。

### 分类与压缩规则

| 项 | 规则 |
|---|---|
| 类别 | 由 `raw-img/<device>/<genre>/` 目录决定，路径即 API 分类 |
| 朝向 | 由类别决定（pc=横、mobile=竖）；素材抓取时已按源规格预筛 |
| 尺寸 | 只缩不放：横图宽 ≤ 1920，竖图宽 ≤ 1080 |
| AVIF | **一律生成，`lossless=True`**，speed 6（无损，不引入第二次压缩损失） |
| WebP | q82，超过 400 KB 依次降到 q76 / q70，仍超再缩 15% |

| 透明通道 | WebP / AVIF 都保留 alpha（已验证 RGBA 回读像素一致） |
| 元数据 | 一律剥掉 EXIF/ICC —— 顺带去掉手机照片里的 GPS 坐标 |
| 旋转 | 先按 EXIF 摆正再压，否则剥掉元数据后图会躺倒、横竖也会判错 |
| 命名 | 内容哈希前 10 位，天然去重；同一张图的三种格式共用 stem |

> AVIF 早先有一条「不比 WebP 小就不存」的规则，已删除 ——
> 回退链从 avif 开始，缺了它等于把最新格式直接从候选里抹掉。
> 代价是 AVIF 通常比 WebP 大（画质更高），这是刻意的取舍。
>
> 想改画质：`AVIF_QUALITY=70 npm run img`，其余档位在 `scripts/optimize-images.py` 顶部。

> `npm run img` 需要 **Python 3 + Pillow**（HEIC 输入还要 `pillow-heif`）。它是一次性的离线步骤，
> 不参与部署构建 —— 线上构建只跑 `npm run build`，纯 Node，不需要 Python。

---

## 访问限流

**代码里不实现限流**，用 EdgeOne 自带的能力：

控制台 → 安全防护 → **速率限制**（Rate Limiting）→ 新建规则

| 项 | 建议值 |
|---|---|
| 匹配路径 | `/api/*` |
| 统计维度 | 客户端 IP（`eo-connecting-ip`） |
| 阈值 | 30 次 / 60 秒 |
| 超限动作 | 拦截并返回 429 |
| 计数周期 | 滑动窗口（若可选） |

放在 CDN/边缘层比自己写强的地方：

- **计数是全站共享的**，不像函数内存在每个实例各算一份
- **超限请求根本不进函数**，不消耗函数调用次数和执行时间
- 冷启动、扩容都不会让计数丢失
- 静态图片（`/img/*`）也能一起保护，而函数层的限流管不到静态资源

如果以后确实需要在应用层也做一层（比如换到没有边缘限流的平台），
`src/ratelimit.js` 那套滑动窗口思路是可以直接搬回来的：按 `eo-connecting-ip` 计数、
窗口内保留时间戳、超限返回 429 + `retry-after`。

## 容量与平台限制

EdgeOne Makers 的三个限制，以及当前占用：

| 限制 | 上限 | 当前 | 余量 |
|---|---|---|---|
| 项目总容量 | 5 GB | **1.68 GB** | 3.3 GB |
| 文件数量 | 20 000 | **8 000**（4000 × 2） | 12 000 |
| 单文件大小 | 25 MB | 最大 **< 1 MB** | 充裕 |

扩容时按这个算：**每加 1 张图 = 2 个文件**（avif/webp）。四类各 1000 张即 8000 个文件。
文件数上限 20 000 意味着理论上限约 10000 张图（每张 avif + webp 两个文件）；
但真正先撞到的是仓库体积和 CDN 流量，不是文件数。

JPEG 兜底层已默认不生成（省了约 92 MB）；需要兼容极老客户端时 `--with-jpeg` 再生成。

---

## 加一言

编辑 `data/quotes.json`，加一条：

```json
{
  "id": 51,
  "hitokoto": "句子",
  "type": "d",
  "from": "出处",
  "from_who": "作者，没有就 null",
  "creator": "classic",
  "created_at": "2026-01-01T00:00:00Z",
  "length": 2
}
```

`id` 唯一。`type` 按 hitokoto 的分类：`a` 动画 `b` 漫画 `c` 游戏 `d` 文学 `e` 原创 `f` 网络 `g` 其他。

---

## 部署

### EdgeOne Makers

仓库里已有 `edgeone.json`：

```json
{
  "installCommand": "npm ci --include=dev",
  "buildCommand": "npm run build",
  "outputDirectory": "public",
  "nodeVersion": "20.18.0",
  "cloudFunctions": { "maxDuration": 30 }
}
```

控制台新建项目 → 关联仓库 → 构建配置读 `edgeone.json` → 点部署。
部署后 `GET /api/stats` 应该返回你数据的真实条数。

> 预览域名 `*.edgeone.cool` 有访问控制，自己 curl 会拿到 401，需要控制台点「预览」拿临时链接。
> 长期使用请绑自有域名。

### 任何支持 Node 20 的环境

```bash
npm ci --include=dev
npm run build
# 产物：cloud-functions/[[default]].js（自包含 ESM，导出 default / fetch / onRequest）
```

它就是一个标准的 `(context) => Response` 处理器，接到任何 fetch 风格的服务上都能跑：

```js
import handler from './cloud-functions/[[default]].js';
const res = await handler({ request: new Request('https://x/api/random') });
```

---

## 结构

```
.
├── edgeone.json                    Makers 部署配置
├── package.json
├── cloud-functions/
│   └── [[default]].js              构建产物（npm run build 生成）
├── src/
│   ├── app.js                      路由（零依赖）
│   ├── quotes.js                   一言取用
│   ├── images.js                   图片取用
│   └── makers.js                   Makers 入口适配
├── raw-img/                        原始素材（.gitignore，不进仓库）
├── data/
│   ├── quotes.json                 一言数据（手工维护）
│   └── images.json                 图片索引（npm run gen 生成）
├── public/
│   ├── index.html                  演示页
│   └── img/{pc,mobile}/{dm,fjbz}/*.{avif,webp}   压缩后的图片（四类）
└── scripts/
    ├── optimize-images.py          转 AVIF(无损)+WebP、摆正 EXIF、按横竖分类
    ├── build.mjs                   esbuild 打包
    ├── gen-images.mjs              扫目录生索引（含宽高与朝向）
    ├── dev.mjs                     本地开发服务器
    └── test.mjs                    接口测试
```

---

## 设计取舍

| 决定 | 原因 |
|---|---|
| 数据放仓库，不放数据库 | 内容量小、更新靠 Git 提交，部署即生效；没有数据库就没有连接串、没有额度、没有故障面 |
| 图片按 device/genre 分目录、路径即分类 | `/pc/fjbz` 这样的短路径直接拿风景横图；调用方一行 <img src> 就够 |
| 原图不进仓库 | 177 MB 原图 → 8 MB WebP + 5 MB AVIF，clone 和部署都快 15 倍以上 |
| WebP + AVIF 双份 | AVIF 再省 35%，但编码慢；只在离线批量做，线上直接给静态文件 |
| 通配不当作点名 | 避免把 AVIF 塞给只支持 WebP 的客户端，宁可少省一点 |
| JSON 在构建期内联 | Makers 的函数是单文件，没有可靠的工作目录可读 |
| 图片走静态层 + 302 | 省带宽、避 6 MB 响应体上限 |
| 用 `crypto.randomInt` | `Math.random() % n` 有取模偏差，会让某些句子出现得明显更频繁 |
| 零运行时依赖 | 少一层供应链风险；`npm ci` 只为构建装 esbuild |

## 已知限制

- 数据量小，`/api/quotes` 一次返回全部也没压力；上千条以后要加分页
- 代码里不做限流：EdgeOne 自带速率限制，在控制台按 IP + 路径配比在应用层实现更准（见下）
- 没有访问统计
- 图片 tag 来自子目录，不支持一张图多个 tag
- 浏览器普遍**显示不了 HEIC/HEIF**：这类图请放 `raw-img/` 转换，别直接丢进 `public/img/`
- AVIF 在很老的浏览器（Chrome < 85 等）不支持；本接口默认给 WebP，只在客户端明确接受时给 AVIF
- `npm run img` 依赖 Python；部署构建不依赖它（只跑 `npm run build`）
