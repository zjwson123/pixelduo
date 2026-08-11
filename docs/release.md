# PixelDuo 发布运行手册

本文是上线前最后一站：从代码到生产可用的核对清单与验证命令。详细部署步骤见
[deploy.md](deploy.md)，合规核对见 [launch-checklist.md](compliance/launch-checklist.md)。

## 0. 代码与管道

- [ ] 代码在 git 仓库且已 push 远端（`git remote -v` 非空）
- [ ] 本地跑通 CI 管道：`./scripts/ci-local.sh` 输出 `CI-LOCAL PASSED`
- [ ] CI（GitHub Actions）在 push 后全绿（单测 / build / e2e）

## 1. 外部服务与密钥（生产 env）

| 变量 | 说明 | 状态 |
|---|---|---|
| `DATABASE_URL` | 托管 Postgres（开启自动备份 + PITR） | 待配置 |
| `REDIS_URL` | 托管 Redis（TLS + 密码） | 待配置 |
| `S3_*` | R2/S3（开启版本控制 + 跨区域复制） | 待配置 |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` | 待配置 |
| `SMTP_URL` / `EMAIL_FROM` | 发信（SES/SendGrid/Resend） | 待配置 |
| `PAYMENT_PROVIDER` + 对应 key | stripe 或 paddle（**禁用 mock**） | 待配置 |
| `SENTRY_DSN` | 错误告警 | 待配置 |
| `GOOGLE/GITHUB_CLIENT_*` | OAuth（可选） | 待配置 |

首次启动后执行：`npx tsx scripts/promote-admin.ts <你的邮箱>` 提权管理员。

## 2. 部署

```bash
docker compose -f docker-compose.prod.yml build web worker rollover
docker compose -f docker-compose.prod.yml up -d
```

Caddy 自动申请 Let's Encrypt 证书（80/443 需公网可达）。

## 3. 上线后冒烟（每项都应有明确输出）

```bash
# 健康（db/redis/storage 全 up，rateLimiter=redis）
curl -fsS https://pixelduo.ai/api/health

# SEO
curl -fsS https://pixelduo.ai/robots.txt | grep Sitemap
curl -fsS https://pixelduo.ai/sitemap.xml | grep urlset

# 安全响应头
curl -sI https://pixelduo.ai/ | grep -iE "content-security-policy|strict-transport-security|x-content-type-options"

# 注册 → 邮箱验证 → 登录 → 生图（网页人工走一遍）
# 支付：真实沙箱（stripe/paddle）下一笔小单 → 收据邮件 → 退款 → 退款邮件 + 积分扣回
# API：创建 Key → curl /api/v1/images/generations → 轮询 → 吊销 → 401
# 管理台：/admin 可登录、可调积分、可删违规图
```

## 4. 监控与告警

- [ ] Sentry 收到第一条测试错误（人工触发一次 500）
- [ ] 备份恢复演练在生产复跑（DB dump 恢复 + `scripts/restore-objects.sh`）
- [ ] 告警渠道确认（Sentry alert 绑邮箱/IM）

## 5. 回滚

- 保留上一版本镜像 tag，`IMAGE_WEB=pixelduo-web:prev docker compose -f docker-compose.prod.yml up -d`
- 含数据库迁移的升级需先备份；迁移回滚人工处理（托管商 PITR）

## 6. 上线后第一周观察

- 队列深度（`/api/health` 的 `queue.queued`）与生图成功率（Sentry）
- 误审核率：`IMAGE_MODERATION=1` 命中拦截数量 vs 投诉
- 成本损耗：退款/失败重试导致的 provider 成本 vs 收入
