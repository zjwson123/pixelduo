# 单服务器上线指南（自托管全栈）

适用：一台 VPS 上跑完整 PixelDuo（Postgres + Redis + MinIO + Caddy HTTPS + web + worker + 备份）。
如果已经有托管 Postgres/Redis/S3，用 [deploy.md](deploy.md) 的 `docker-compose.prod.yml` 更省心。

## 1. 买服务器

- 推荐配置：**4C8G**（跑 3 个生图 worker + 数据库 + 图片存储，8GB 更稳；预算紧可 2C4G 先跑 2 个 worker）
- 系统：Ubuntu 22.04 / 24.04
- 常见渠道：DigitalOcean / Vultr / Hetzner（海外）；国内访问需考虑备案，先用海外节点 + 海外收款（Stripe/Paddle）最省事
- 域名：把 `pixelduo.ai` 的 DNS **A 记录**指向服务器 IP，并开放 80/443 端口（防火墙）

## 2. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录后生效
```

## 3. 拉代码并配置

```bash
git clone git@github.com:zjwson123/pixelduo.git && cd pixelduo
cp .env.example .env.production
# 编辑 .env.production，必须填：
#   CADDY_DOMAIN=pixelduo.ai
#   NEXTAUTH_URL=https://pixelduo.ai
#   NEXTAUTH_SECRET=$(openssl rand -base64 32)
#   POSTGRES_PASSWORD / REDIS_PASSWORD / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
#   MODELVERSE_IMAGE_API_KEY / ARK_IMAGE_API_KEY / DEEPSEEK_API_KEY
#   VISION_MODERATION_API_KEY（+ BASE_URL，若不走默认网关）
#   PAYMENT_PROVIDER=stripe|paddle + 对应 key / webhook secret
#   SMTP_URL / EMAIL_FROM
#   SENTRY_DSN（可选）
set -a; source .env.production; set +a
```

## 4. 启动

```bash
docker compose -f docker-compose.single.yml up -d --build --scale worker=3
```

> **国内服务器先配 Docker 镜像加速，否则 `--build` 会卡在拉基础镜像上**（本机实测两条构建路径都停在解析 `docker.io/library/node:24-alpine`，CPU ≈0%，既不是编译慢也不是 Dockerfile 问题）：在 Docker 配置里加一个 registry mirror（阿里云「容器镜像服务 → 镜像加速器」会给出专属地址）后重启 Docker，再执行下面的 `--build`。这一步不做，`up -d --build` 会长时间无输出。

首次会自动：建库迁移 → 起 Caddy 并申请 Let's Encrypt 证书 → web/3×worker/rollover/备份全部上线。
3 个 worker 并发生图（每个 worker 同一时刻只处理 1 个任务，数据库队列自动分发，互不抢单）。
如果机器只有 2C4G，把命令里的 `worker=3` 改成 `worker=2`。

## 5. 验证

```bash
# 健康：真实响应体只有 ok / service / db / redis / storage / queue.active / time。
# ok:false 时它也返回 200（只有探测本身抛异常才 503），所以 `curl -fsS` 只能证明
# "服务在响应"——redis 挂了它会照旧退出 0，而 lib/rate-limit.ts 会静默退化成
# 进程内限流（每个 worker 各限一份），这正是冒烟必须看 JSON 的原因：
curl -sS https://pixelduo.ai/api/health \
  | jq -e '.service == "pixelduo" and .ok and .db == "up" and .redis == "up" and .storage == "up"'
# 没装 jq 就退化成 grep '"ok":true'（同样是粗判）；redis 字段在未配置 REDIS_URL
# 时是 "unconfigured"，生产必须是 "up"。

# 提权管理员 / 重置 2FA：这两条必须在容器里跑。宿主机上只有 Docker（第 2 步只装了
# Docker，第 3 步只 clone 了代码），npx 会去网上拉 tsx，而 DATABASE_URL 里的主机名
# `db` 只在 compose 网络里能解析（db 也没有映射宿主端口），所以 `npx tsx
# scripts/*.ts` 在宿主机上必然失败。worker 镜像里带着 node_modules + prisma：
docker compose -f docker-compose.single.yml run --rm worker npx tsx scripts/promote-admin.ts <你的邮箱>
docker compose -f docker-compose.single.yml run --rm worker npx tsx scripts/reset-2fa.ts <用户邮箱> --notify
# reset-2fa 会吊销该用户全部会话与 API Key 并邮件通知本人。
```

然后按 [release.md](release.md) 的冒烟清单走一遍：注册→邮箱验证→真实支付一笔→退款→API Key→管理台。

## 6. 日常运维

- 升级：`git pull && docker compose -f docker-compose.single.yml up -d --build --scale worker=3`（注意：每次 `up` 都要带 `--scale worker=3`，不带会缩回 1 个 worker）
- 扩缩 worker：`docker compose -f docker-compose.single.yml up -d --scale worker=3`（改数字即可，服务不中断）
- 备份：DB 每天进 `./backups/`（保留 14 份），图片镜像进 `./backups/objects/`（保留 7 份）；建议把 `./backups/` 挂到对象存储或异地拷贝
- 监控：Sentry DSN 生效后，异常自动上报
- 回滚：升级前把当前镜像存成 prev —— `docker tag image-gen-web:latest image-gen-web:prev && docker tag image-gen-worker:latest image-gen-worker:prev`；
  出问题先 `docker tag image-gen-web:prev image-gen-web:latest && docker tag image-gen-worker:prev image-gen-worker:latest`，
  再 `docker compose -f docker-compose.single.yml up -d --scale worker=3`（**不带** `--build`：带 `--build` 会在启动前重新构建并把 prev 覆盖掉，这也是"回滚后问题照旧"的常见原因）。数据库迁移不随镜像回滚，含迁移的升级要先备份。

## 7. 之后想迁移到托管服务

把 `.env.production` 的 `DATABASE_URL`/`REDIS_URL`/`S3_*` 换成托管商连接串，删掉 db/redis/storage 相关服务，改用 `docker-compose.prod.yml` 即可（数据迁移用 `pg_dump` + `mc mirror`）。
