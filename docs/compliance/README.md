# PixelDuo 合规与运营文档

> MVP 阶段为免费 Beta（支付壳子），不面向境内公众收费；以下为**商业化上线前**必须完成的合规基线。

## 文档

- [用户条款（ToS）](terms.md)
- [隐私政策（Privacy，含 GDPR）](privacy.md)
- [上线前合规清单（launch checklist）](launch-checklist.md)

## 实现现状

- ✅ AI 内容标识策略：Seedream 输出自带"AI生成"标识；免费档前端叠加平台角标；gpt-image-2 输出需平台侧补标识（见 launch-checklist）
- ✅ 内容安全：前置关键词过滤 + 图像侧可插拔审计接口（`IMAGE_NSFW_ENDPOINT`，未配置时跳过并记录）
- ✅ GDPR 数据导出/删除 API：`POST /api/account/export`、`POST /api/account/delete`
- ✅ 隐私基线：密码 bcrypt、会话 JWT、图片私有存储 + 鉴权访问、`.env` 不入库
- ⏳ 上线前：ICP 备案、AIGC 服务备案/算法备案、真实 NSFW 检测器、DMCA 客服邮箱、收费支付渠道
