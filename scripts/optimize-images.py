#!/usr/bin/env python3
# scripts/optimize-images.py
#
# 把 raw-img/ 里的原图压成 WebP + AVIF，按横竖分类输出到 public/img/。
#
# 为什么要有这一步：
#   - 原图动辄 10+ MB，直接进仓库会让 clone 和部署都变慢
#   - 手机看竖图、电脑看横图，接口需要知道每张图的朝向
#   - AVIF 比 WebP 再小 20~40%，但编码慢，只适合离线批量做
#
# 用法：
#   python scripts/optimize-images.py              # 生成 WebP + AVIF
#   python scripts/optimize-images.py --no-avif    # 只生成 WebP（快很多）
#   python scripts/optimize-images.py --dry-run    # 只看会做什么
#
# 支持的输入格式取决于 Pillow 的编译选项，常见的有：
#   JPEG / PNG / WebP / GIF / BMP / TIFF / AVIF
#   （HEIC 需要额外插件，未安装时会明确报错，而不是静默跳过）
#
# 规则：
#   朝向：宽高比 >= 1.15 横图，<= 0.87 竖图，其余方图
#   尺寸：横图宽 <= 1920，竖图宽 <= 1080，方图边长 <= 1440（只缩不放）
#   体积：WebP 超过 400 KB 就降质量重压（80 -> 72 -> 65），仍超再缩 15%
#   命名：内容哈希前 10 位，天然去重；同名两份文件（.webp / .avif）
#        同一张图的两种格式共用 stem，接口据此互相切换

import os
import sys
import hashlib
import io
from PIL import Image, ImageOps, ImageFilter

# HEIC/HEIF 需要 pillow-heif 注册解码器，否则 Image.open 会直接报不认识这个格式。
# 没装也不算失败 —— 只是那几种文件会被跳过并给出提示。
HEIF_OK = False
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def arg_value(flag, default):
    """支持 --src DIR / --dst DIR，方便自测时不碰真实素材目录。"""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return os.path.abspath(sys.argv[i + 1])
    return default


SRC = arg_value("--src", os.path.join(ROOT, "raw-img"))
DST = arg_value("--dst", os.path.join(ROOT, "public", "img"))

MAX_WIDTH = {"landscape": 1920, "portrait": 1080, "square": 1440}
MAX_BYTES = 400 * 1024

# 输入侧尽量放开；真正能读哪些由 Pillow（+ pillow-heif）决定
EXTS = {
    ".jpg", ".jpeg", ".jfif", ".png", ".webp", ".gif", ".bmp",
    ".tif", ".tiff", ".avif",
    ".heic", ".heif", ".hif",   # 需要 pillow-heif
}

# 画质阶梯：AVIF 无损 → WebP 有损（JPEG 兜底层已下线）。
#
# AVIF 走 lossless：实测对这批二次元图，AV1 无损模式编出来普遍比有损 q90 还小，
# 而且完整保留解码后的像素（不引入新的压缩损失）—— 画质与体积双赢，
# 所以把它作为主推格式。WebP 保持有损 q82 作为兼容性最好的默认格式。
#
# 注意：素材本身多为 WebP/JPG（已是有损），"无损"指的是不再引入第二次损失，
# 不是把已经被压掉的原始画质变回来。
AVIF_LOSSLESS = "--avif-lossy" not in sys.argv
AVIF_QUALITY = int(os.environ.get('AVIF_QUALITY', 90))  # 仅 --avif-lossy 时生效
AVIF_SPEED = 6  # 0 最慢最好，10 最快最差
WEBP_QUALITIES = [82, 76, 70]   # 超过体积上限时依次往下降
QUALITIES = WEBP_QUALITIES

# JPEG 是最后一道兜底（只给不支持 WebP/AVIF 的客户端），不值得占和 WebP 一样的体积。
# 实测 JPEG 会占整个产物的一半，而它几乎不会被用到，
# 所以单独给一套更小的尺寸上限：宽度减到 2/3，画质再低一档。
JPEG_MAX_WIDTH = {"landscape": 1280, "portrait": 720, "square": 960}
JPEG_QUALITY = 70
MAX_JPEG_BYTES = 220 * 1024


def orientation(w, h):
    r = w / h
    if r >= 1.15:
        return "landscape"
    if r <= 0.87:
        return "portrait"
    return "square"


def target_orientation(sub_dir):
    """目录决定目标朝向：pc/ 类要横图，mobile/ 类要竖图。"""
    first = (sub_dir or "").split("/")[0].lower()
    if first == "mobile":
        return "portrait"
    if first == "pc":
        return "landscape"
    return None  # 不强制，按原图朝向走


def crop_to(im, target):
    """把图裁切到目标朝向，用「边缘密度」选内容最丰富的窗口，而不是死板居中。

    横 → 竖：在横图上滑一个竖条窗口（宽 = 高 × 9/16），
              选边缘像素最多的位置 —— 主体/细节多的地方边缘密度高，
              这样比居中裁切更不容易把主体裁掉。
    竖 → 横：同理，滑横条窗口选边缘最多的位置。

    窗口位置在最右侧时可能出现小数误差，故边界都 clamp 回合法区间。
    """
    w, h = im.size
    if target == "portrait" and w > h:
        new_w = max(1, int(h * 9 / 16))
        if w - new_w <= 2:
            return im
        return _crop_best_band(im, band_w=new_w, band_h=h, axis="horizontal")
    if target == "landscape" and h > w:
        new_h = max(1, int(w * 9 / 16))
        if h - new_h <= 2:
            return im
        return _crop_best_band(im, band_w=w, band_h=new_h, axis="vertical")
    return im


def _crop_best_band(im, band_w, band_h, axis):
    """在 im 上滑动一个 band_w×band_h 的窗口，选边缘密度最高的位置裁剪。

    axis='horizontal' → 窗口左右滑动（横图裁竖）；axis='vertical' → 窗口上下滑动（竖图裁横）。
    用小尺寸灰度图 + FIND_EDGES 加速，结果映射回原图坐标。
    """
    w, h = im.size
    # 缩到宽约 160 的小图做边缘检测，快且足够判断主体位置
    small = im.convert("L").resize((160, max(1, int(160 * h / w))), Image.LANCZOS)
    edges = small.filter(ImageFilter.FIND_EDGES)
    sw, sh = edges.size
    px = list(edges.getdata())

    if axis == "horizontal":
        band_small_w = max(1, int(sw * band_w / w))
        # 每列边缘强度和
        col = [0] * sw
        for y in range(sh):
            base = y * sw
            for x in range(sw):
                col[x] += px[base + x]
        # 滑窗求和，选最大
        best = -1
        best_x = 0
        run = 0
        for x in range(sw - band_small_w + 1):
            if x == 0:
                run = sum(col[0:band_small_w])
            else:
                run += col[x + band_small_w - 1] - col[x - 1]
            if run > best:
                best = run
                best_x = x
        left = int(best_x * w / sw)
        left = max(0, min(left, w - band_w))
        return im.crop((left, 0, left + band_w, band_h))

    # vertical：窗口上下滑动
    band_small_h = max(1, int(sh * band_h / h))
    row = [0] * sh
    for y in range(sh):
        row[y] = sum(px[y * sw:(y + 1) * sw])
    best = -1
    best_y = 0
    run = 0
    for y in range(sh - band_small_h + 1):
        if y == 0:
            run = sum(row[0:band_small_h])
        else:
            run += row[y + band_small_h - 1] - row[y - 1]
        if run > best:
            best = run
            best_y = y
    top = int(best_y * h / sh)
    top = max(0, min(top, h - band_h))
    return im.crop((0, top, band_w, top + band_h))


def collect():
    out = []
    if not os.path.isdir(SRC):
        return out
    for base, _, files in os.walk(SRC):
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() in EXTS:
                out.append(os.path.join(base, name))
    return sorted(out)


def normalize_mode(im):
    """保留透明通道：WebP 和 AVIF 都支持 alpha，没理由在这里丢掉。

    判据不能只看 mode —— 调色板 PNG（P 模式）的透明信息藏在 info['transparency'] 里，
    getbands() 只会返回 ('P',)。用 has_transparency_data 一次问清楚，
    老版本 Pillow 没有这个属性时退回检查 info。
    """
    if im.mode in ("RGB", "RGBA"):
        return im
    has_alpha = getattr(im, "has_transparency_data", None)
    if has_alpha is None:
        has_alpha = "transparency" in im.info or "A" in im.getbands()
    return im.convert("RGBA" if has_alpha else "RGB")


def encode_webp(im, quality):
    buf = io.BytesIO()
    # method=6 压缩得更狠（慢一点无所谓，这是一次性离线操作）
    # 不传 exif/icc_profile 就等于剥掉元数据，顺带去掉手机拍摄的 GPS
    im.save(buf, "WEBP", quality=quality, method=6)
    return buf.getvalue()


def encode_avif(im, quality=AVIF_QUALITY, speed=AVIF_SPEED):
    buf = io.BytesIO()
    if AVIF_LOSSLESS:
        # lossless=True 时 Pillow 不接受 quality 参数，只传 speed
        im.save(buf, "AVIF", lossless=True, speed=speed)
    else:
        im.save(buf, "AVIF", quality=quality, speed=speed)
    return buf.getvalue()


def encode_jpeg(im, quality=JPEG_QUALITY):
    # JPEG 没有透明通道：带 alpha 的图先铺白底，否则保存会直接报错或变黑块
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    # optimize + progressive：体积小一点，解码渐进显示
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


DRY = "--dry-run" in sys.argv
WANT_AVIF = "--no-avif" not in sys.argv
# 默认不生成 JPEG 兜底层；需要时显式加 --with-jpeg
WANT_JPEG = "--with-jpeg" in sys.argv


def process_one(path):
    """处理单张图：返回一行结果。设计成纯函数，方便丢进进程池并行跑。

    并发写文件是安全的：输出文件名是内容哈希，两张图撞哈希就写同一份内容。
    """
    rel = os.path.relpath(path, SRC)
    # 输出子目录 = 素材所在的相对目录，例如 raw-img/pc/dm/x.webp → public/img/pc/dm/*.avif
    # 这样 public 下的路径天然就是 API 想要的 /img/pc/dm/... 结构。
    sub_dir = os.path.dirname(rel).replace("\\", "/")
    size_before = os.path.getsize(path)
    try:
        with Image.open(path) as src:
            src.load()
            # 手机拍的竖图常常是「横着存 + EXIF 里写个旋转标记」。
            # 不先按 EXIF 摆正，后面剥掉元数据就会变成一张躺倒的图，
            # 而且朝向分类也会算错（横竖颠倒）。
            im = ImageOps.exif_transpose(src) or src
            w, h = im.size
            orient = orientation(w, h)

            # 目录决定目标朝向：mobile/ 类强制竖图，pc/ 类强制横图。
            # 素材朝向不符时居中裁切（风景横图裁成手机竖图等），而不是整图缩放。
            target = target_orientation(sub_dir)
            if target and target != orient:
                im = crop_to(im, target)
                orient = target

            limit = MAX_WIDTH[orient]

            if im.width > limit:
                im = im.resize((limit, round(im.height * limit / im.width)), Image.LANCZOS)
            im = normalize_mode(im)

            # ---- WebP ----
            webp = None
            for q in QUALITIES:
                webp = encode_webp(im, q)
                if len(webp) <= MAX_BYTES:
                    break
            else:
                im = im.resize((max(1, int(im.width * 0.85)), max(1, int(im.height * 0.85))), Image.LANCZOS)
                webp = encode_webp(im, QUALITIES[-1])

            digest = hashlib.sha256(webp).hexdigest()[:10]

            # ---- AVIF（同 stem，方便接口切换）----
            avif = b""
            avif_err = ""
            if WANT_AVIF:
                try:
                    # 一律保留：接口的回退链从 avif 开始，缺了它就等于把
                    # "最新的格式" 直接从候选里抹掉
                    avif = encode_avif(im)
                except Exception as e:
                    avif_err = f"AVIF 失败 {e}"

            # ---- JPEG 兜底（默认关闭）----
            # WebP 全球支持率约 97%，剩下的是 IE11 / 老 Safari 这类已经没量的客户端。
            # 这层占了整个产物约 1/5（实测 876 张 = 91.8 MB），却几乎不会被用到，
            # 所以默认不生成。需要兼容老客户端时加 --with-jpeg 再跑一次即可。
            jpeg = b""
            if WANT_JPEG:
                jlim = JPEG_MAX_WIDTH[orient]
                jim = im
                if jim.width > jlim:
                    jim = jim.resize((jlim, round(jim.height * jlim / jim.width)), Image.LANCZOS)
                jpeg = encode_jpeg(jim, JPEG_QUALITY)
                if len(jpeg) > MAX_JPEG_BYTES:
                    jpeg = encode_jpeg(jim, max(58, JPEG_QUALITY - 8))

            if not DRY:
                out_dir = os.path.join(DST, sub_dir) if sub_dir else DST
                os.makedirs(out_dir, exist_ok=True)
                with open(os.path.join(out_dir, digest + ".webp"), "wb") as f:
                    f.write(webp)
                if avif:
                    with open(os.path.join(out_dir, digest + ".avif"), "wb") as f:
                        f.write(avif)
                if jpeg:
                    with open(os.path.join(out_dir, digest + ".jpg"), "wb") as f:
                        f.write(jpeg)

            return (sub_dir, rel, w, h, orient, size_before, len(webp), len(avif), len(jpeg), digest, avif_err)

    except Exception as e:
        return ("?", rel, 0, 0, "?", size_before, 0, 0, 0, "-", f"失败: {str(e)[:60]}")


def main():
    dry = DRY
    want_avif = WANT_AVIF

    try:
        from PIL import features
        if want_avif and not features.check("avif"):
            print("[optimize] 这个 Pillow 不支持 AVIF 编码，本次只生成 WebP")
            globals()["WANT_AVIF"] = False
    except Exception:
        globals()["WANT_AVIF"] = False

    print(f"[optimize] HEIC/HEIF 解码: {'可用' if HEIF_OK else '不可用（pip install pillow-heif）'}")
    print(f"[optimize] JPEG 兜底层: {'生成' if WANT_JPEG else '跳过（加 --with-jpeg 开启）'}")
    print(f"[optimize] AVIF 模式: {'无损 lossless' if AVIF_LOSSLESS else '有损 q' + str(AVIF_QUALITY)}")

    files = collect()
    if not files:
        print(f"[optimize] {SRC} 里没有图片。\n"
              f"           把原始素材丢进 raw-img/，再跑这个脚本。")
        return 0

    os.makedirs(DST, exist_ok=True)

    total_before = total_webp = total_avif = total_jpeg = 0
    counts = {"landscape": 0, "portrait": 0, "square": 0}
    rows = []
    failures = []
    seen = {}

    # 多进程：解码 4K 图是主要开销，单进程跑 800 多张要好几个小时。
    # 留两个核给系统，其余全用上。
    workers = max(1, min(int(os.environ.get("JOBS", (os.cpu_count() or 4) - 2)), 16))
    print(f"[optimize] 并行 {workers} 进程处理 {len(files)} 张")

    if workers == 1:
        results = (process_one(p) for p in files)
    else:
        from concurrent.futures import ProcessPoolExecutor
        pool = ProcessPoolExecutor(max_workers=workers)
        results = pool.map(process_one, files, chunksize=1)

    done = 0
    class_counts = {}
    for row in results:
        sub_dir, rel, w, h, orient, size_before, wb, at, jp, digest, note = row
        done += 1

        if note.startswith("失败"):
            failures.append((rel, note))
            rows.append(row)
        elif digest in seen:
            # 内容重复：文件本身已经按哈希写过了，这里只记账
            rows.append((sub_dir, rel, w, h, orient, size_before, wb, 0, 0, digest, "重复内容，跳过"))
            total_before += size_before
        else:
            seen[digest] = rel
            counts[orient] = counts.get(orient, 0) + 1
            if sub_dir:
                class_counts[sub_dir] = class_counts.get(sub_dir, 0) + 1
            total_before += size_before
            total_webp += wb
            total_avif += at
            total_jpeg += jp
            rows.append(row)

        if done % 100 == 0 or done == len(files):
            print(f"  ... {done}/{len(files)}")

    for sub_dir, rel, w, h, orient, before, webp, avif, jpeg, stem, note in rows:
        avif_s = f"{avif/1024:6.1f}" if avif else "    —  "
        print(f"  {sub_dir:16} {w:5}x{h:<5} {before/1024/1024:6.2f} MB -> "
              f"webp {webp/1024:6.1f}  avif {avif_s} KB  {stem:12} {note}")

    print()
    for cls in sorted(class_counts):
        print(f"[optimize]   {cls:16} {class_counts[cls]} 张")
    print(f"[optimize] 横图 {counts['landscape']}  竖图 {counts['portrait']}  方图 {counts['square']}  合计 {sum(class_counts.values())}")
    print(f"[optimize] 原图 {total_before/1024/1024:.1f} MB -> "
          f"WebP {total_webp/1024/1024:.2f} MB"
          + (f"  + AVIF {total_avif/1024/1024:.2f} MB" if total_avif else "")
          + f"  + JPEG {total_jpeg/1024/1024:.2f} MB"
          + f"（WebP 相对原图省 {100*(1-total_webp/max(total_before,1)):.1f}%）")

    if failures:
        print(f"[optimize] ⚠ {len(failures)} 个文件读不了：")
        for rel, err in failures[:10]:
            print(f"    {rel}: {err}")
        if any(r.lower().endswith((".heic", ".heif")) for r, _ in failures):
            print("    HEIC/HEIF 需要额外解码器：pip install pillow-heif")

    if dry:
        print("[optimize] --dry-run：没有写入任何文件")
    else:
        print(f"[optimize] 输出目录 {DST}")
        print("[optimize] 下一步：npm run gen && npm run build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
