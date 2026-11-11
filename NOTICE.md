# 许可与来源声明

## 本项目许可

本仓库整体采用 **GNU Affero General Public License v3.0（AGPL-3.0）**，全文见 [LICENSE](./LICENSE)。

原因见下：一言句子包是 AGPL-3.0，且我们的服务端把它打包进了产物、通过网络对外提供，
因此整个派生作品需要按 AGPL-3.0 授权，并向网络用户提供 Corresponding Source。

## 第三方内容

### 一言句子（AGPL-3.0，强 copyleft）

- 来源：[hitokoto-osc/sentences-bundle](https://github.com/hitokoto-osc/sentences-bundle)
  上游自身声明：*「本库遵循 AGPL 开源授权……除我们提供的超链接调用方式不受 AGPL 的
  开源、传染影响，其余使用方式都需要遵循 AGPL 授权」*
- 本仓库中的 `data/quotes.remote.json` 是从上游 `sentences/{a..l}.json`
  **12 个分类全量**拉取、按正文去重、字段裁剪后得到的**派生/修改版本**
  （原样保留了 `hitokoto` / `from` / `from_who` / `type` / `creator` 等字段）。
  当前上游 11,266 条，去重后 10,605 条；由 GitHub Actions 每天定时同步，
  版本记录在 `data/sentences-version.json`。
- 上游著作权并非完全由一言网持有。句子原作者若不愿参与公共分享，可联系上游
  `i@loli.online` 移除；我们也会在本仓库中同步跟进。
- `data/quotes.json` 里的 50 条古典诗词是公有领域内容，不受此约束，但为明确起见
  一并放在同一许可下。

**重要**：本仓库采用的方式是「把句子包下载并打包进服务端产物」，**不是**上游所说的
「超链接调用方式」。因此不适用那条例外，需要遵守 AGPL-3.0 全部条款，包括第 13 条
（Network Interaction）—— 通过网络使用本服务的用户有权获得本项目的完整源码。
本仓库是公开的，源码地址即：<https://github.com/chenyimaio/random-api>

### 图片（各部分权利状况不同）

`public/img/` 下的图片来自公开随机图片接口：

| 来源 | 用途 |
|---|---|
| `t.alcy.cc`（moez / mp / pc） | 二次元随机图源 |
| `api.loliapi.com/acg/` | 二次元随机图源 |
| `api.anosu.top/img` | 二次元竖图（Pixiv 代理） |
| `uapis.cn`（category=acg / landscape） | 二次元 / 风景图源 |
| `api.weirain.com`（fj / pc / sj） | 风景 / 壁纸图源 |
| `tu.ltyuanfang.cn/api/fengjing.php` | 风景 4K 图源 |
| Bing 官方每日壁纸（经 `bing.npanuhin.me` 归档） | 风景横图 / 竖图 |

图片的原始著作权归各自画师/摄影师/上传者所有，**本仓库不对图片主张任何权利**。
这里仅做技术性的转码（AVIF / WebP / JPEG）、缩放与随机分发。
若您是某张图的权利人、不希望出现在这里，请通过本仓库的 Issue 联系，我们会立即移除。

> 注意：由于句子数据是 AGPL-3.0，而图片与代码一起打包成同一个部署产物，
> **整个仓库整体按 AGPL-3.0 授权**。这不改变图片原作者对其作品的权利。

### 代码

`src/**`、`scripts/**`、`public/index.html` 及 `edgeone.json` 等为本项目原创，
随仓库整体按 AGPL-3.0 授权。

## 如何合规使用本仓库

1. **部署 / 改造本服务**：可以，但需继续以 AGPL-3.0 授权你的修改版本，
   并向通过网络使用它的用户提供修改后的完整源码（AGPL §13）。
2. **只想用一言句子、不想被 AGPL 传染**：改用上游官方的
   **超链接调用方式**（运行时请求 `https://v1.hitokoto.cn/`），
   不要像本项目这样把句子包下载、打包进自己的产物里。
   上游 README 明确说明该方式不受 AGPL 传染影响。
3. **只用图片或只用随机数/随机字符串接口**：可以把 `src/numbers.js`、
   `src/strings.js`、`src/entropy.js` 单独取出使用；但整个仓库作为一个整体
   仍是 AGPL-3.0，分发时请保留本声明与 LICENSE。

## 声明

本项目与 hitokoto.cn / Hitokoto 开源社区、以及各图片源无关联。
句子与图片的著作权归各自权利人所有。
