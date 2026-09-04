# API 设计规范

## RESTful 接口约定

所有 API 遵循 RESTful 风格。URL 使用小写字母和连字符，例如 `/api/user-profiles`。版本号放在 URL 路径中：`/api/v1/users`。

状态码使用标准 HTTP 状态码：200 成功、201 已创建、400 请求格式错误、401 未认证、403 无权限、404 资源不存在、500 服务端错误。

请求体和响应体统一使用 JSON 格式。日期字段使用 ISO 8601 格式，例如 `2026-04-15T08:30:00Z`。分页使用 `page` 和 `pageSize` 参数，默认 `pageSize=20`，最大不超过 100。

## 认证与授权

使用 JWT Bearer Token 认证。Token 放在 Authorization 头中：`Authorization: Bearer <token>`。Token 有效期 24 小时，刷新 Token 有效期 7 天。

Token 中包含用户 ID、角色、过期时间。不要在 Token 中存放敏感信息，因为 JWT 的 payload 是 Base64 编码而不是加密的。

权限控制使用 RBAC（基于角色的访问控制）。定义了三个角色：admin（管理员）、editor（编辑）、viewer（只读）。每个 API 接口在路由定义中声明所需的最低角色。

## 错误处理

所有错误响应使用统一格式：`{ "error": { "code": "USER_NOT_FOUND", "message": "用户不存在", "details": {} } }`。错误码使用大写蛇形命名，例如 `RATE_LIMIT_EXCEEDED`、`INVALID_INPUT`。

客户端错误（4xx）返回友好的错误消息，不要暴露内部实现细节。服务端错误（5xx）记录完整的堆栈跟踪到日志，但只向客户端返回通用错误消息。

## 限流策略

API 限流使用令牌桶算法。默认限制：每个用户每分钟 60 次请求，每秒最多 10 次。企业版用户限制提升到每分钟 600 次。

超出限流时返回 429 状态码，响应头中包含 `X-RateLimit-Remaining` 和 `X-RateLimit-Reset` 信息。

## 上次 API 变更事故

2026 年 3 月 20 日，v2 接口上线时出了兼容性事故。原因是 `/api/v2/users` 的响应格式发生了 breaking change——`user.name` 字段从字符串改成了 `{ first: string, last: string }` 对象，但没有通知前端团队。

影响范围：移动端 App 崩溃率从 0.1% 飙升到 15%，持续了 6 小时。

事后建立的规则：
1. 所有 breaking change 必须在 v2 路径下，且保留 v1 至少 3 个月
2. 发布前必须在 staging 环境跑完整 E2E 测试
3. 每次 API 变更必须更新 OpenAPI spec 文档
4. 建立 API changelog 通知机制，变更前 7 天邮件通知所有消费方

## 文档维护

API 文档使用 OpenAPI 3.1 规范。文档与代码同仓库管理，PR 修改了 API 接口必须同步更新文档。使用 Swagger UI 自动生成可交互的文档页面。

每个接口必须包含：请求参数描述、响应格式示例、可能的错误码列表、认证要求、限流说明。
