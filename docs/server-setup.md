# 单服务器上线指南（自托管全栈）

适用：一台 VPS 上跑完整 PixelDuo（Postgres + Redis + MinIO + Caddy HTTPS + web + worker + 备份）。
如果已经有托管 Postgres/Redis/S3，用 [deploy.md](deploy.md) 的 `docker-compose.prod.yml` 更省心。

## 1. 买服务器

- 推荐配置：**≥ 2C4G**（生图是 worker 异步处理，4C8G 更稳）
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
docker compose -f docker-compose.single.yml up -d --build
```

首次会自动：建库迁移 → 起 Caddy 并申请 Let's Encrypt 证书 → web/worker/rollover/备份全部上线。

## 5. 验证

```bash
curl -fsS https://pixelduo.ai/api/health          # db/redis/storage 全 up
npx tsx scripts/promote-admin.ts <你的邮箱>        # 提权管理员（在服务器上跑）
```

然后按 [release.md](release.md) 的冒烟清单走一遍：注册→邮箱验证→真实支付一笔→退款→API Key→管理台。

## 6. 日常运维

- 升级：`git pull && docker compose -f docker-compose.single.yml up -d --build`
- 备份：DB 每天进 `./backups/`（保留 14 份），图片镜像进 `./backups/objects/`（保留 7 份）；建议把 `./backups/` 挂到对象存储或异地拷贝
- 监控：Sentry DSN 生效后，异常自动上报
- 回滚：升级前 `docker tag image-gen-web:latest image-gen-web:prev`，出问题 `docker compose -f docker-compose.single.yml up -d` 换回

## 7. 之后想迁移到托管服务

把 `.env.production` 的 `DATABASE_URL`/`REDIS_URL`/`S3_*` 换成托管商连接串，删掉 db/redis/storage 相关服务，改用 `docker-compose.prod.yml` 即可（数据迁移用 `pg_dump` + `mc mirror`）。
