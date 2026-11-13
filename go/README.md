# random-api (Go 版)

原 Node.js 实现的 Go 重写，**单文件、零依赖、静态编译**，用于裸机部署。

## 为什么重写

- 原版需要 Node 运行时（约 60 MB）
- Go 版编译产物 5.3 MB，静态链接，不依赖任何系统库
- 内存占用从 45.8 MiB 降到 22.7 MiB
- 启动即把 3000 张图片索引 + 10655 条句子全部载入内存，请求零 IO

## 编译

```bash
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o random-api main.go
```

## 运行

```bash
PORT=8790 \
IMG_BASE_URL=https://img.ifyi.top \
APP_ROOT=/mnt/random-api \
./random-api
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8790` | 监听端口（只绑 127.0.0.1） |
| `IMG_BASE_URL` | `https://img.ifyi.top` | 图片 CDN 前缀 |
| `APP_ROOT` | `.` | 应用根目录，下面找 `data/` 和 `public/` |

## 目录约定

```
/mnt/random-api/
├── bin/random-api       编译产物
├── data/images.json     图片索引
├── data/quotes.json     精编句子
├── data/quotes.remote.json  远程句子库
├── public/index.html    前端页面
└── logs/
```

## 路由

| 路径 | 说明 | Cache-Control |
|---|---|---|
| `GET /api/random` | 302 到图片 CDN | `no-store` |
| `GET /api/random?info=1` | 图片 JSON 详情 | `no-store` |
| `GET /api/hitokoto` | 随机一言 | `no-store` |
| `GET /api/hitokoto?daily=1` | 每日一句（按日期哈希，全站一致） | `public, max-age=3600` |
| `GET /api/stats` | 统计 | `public, max-age=300` |
| `GET /api/string` | **已下线**，返回 410 | - |
| `GET /pc/dm` 等 | 兼容路径 | `no-store` |

参数：

- `?genre=dm|fjbz` 题材
- `?device=pc|mobile` 方向
- `?format=avif|webp` 格式
- `?class=pc/dm` 完整分类（可代替上面两个）
- `?info=1` 返回 JSON
- `?type=a,b,d` 一言多类型（逗号分隔）

多个参数用 `&` 连接，不是 `?`。

## systemd

见同目录 `random-api.service`。
