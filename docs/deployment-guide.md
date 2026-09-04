# 部署指南

## 环境要求

生产环境推荐 Node.js 22+ 版本，搭配 pnpm 作为包管理器。服务器建议 4 核 8GB 以上配置，SSD 硬盘。

数据库使用 PostgreSQL 16，需要预先创建数据库和用户。连接字符串格式：`postgresql://user:password@host:5432/dbname`。

## 部署步骤

第一步是拉取代码并安装依赖。使用 `git clone` 获取最新代码，然后运行 `pnpm install --frozen-lockfile` 确保依赖版本一致。

第二步是配置环境变量。复制 `.env.example` 为 `.env`，填入数据库连接、API Key 等敏感信息。注意不要把 `.env` 提交到 Git。

第三步是运行数据库迁移。执行 `pnpm db:migrate` 应用所有待执行的迁移脚本。如果迁移失败，检查数据库连接是否正常。

第四步是构建生产版本。运行 `pnpm build` 生成优化后的产物。构建过程大约需要 2-3 分钟。

第五步是启动服务。使用 `pnpm start` 启动，或者用 PM2 做进程管理：`pm2 start ecosystem.config.js`。

## 上次部署事故

2026 年 4 月 15 日的部署出了一次严重事故。原因是数据库迁移脚本修改了 users 表的 email 字段，从 VARCHAR(255) 改为 VARCHAR(100)，导致超过 100 字符的邮箱地址被截断。

影响范围：23 个企业用户的邮箱地址被截断，导致登录失败。问题持续了 4 小时才被发现。

事后复盘的教训：
1. 修改列类型前必须先检查现有数据是否兼容
2. 迁移脚本要有回滚方案
3. 部署后要跑一遍冒烟测试
4. 关键字段修改需要 DBA 审批

## 监控与告警

服务启动后需要配置以下监控：
- 健康检查：`GET /health` 每 30 秒请求一次
- CPU/内存告警阈值：CPU > 80% 持续 5 分钟，内存 > 85%
- 错误率告警：5xx 错误率 > 1% 持续 3 分钟
- 延迟告警：P99 延迟 > 2 秒

Grafana 面板地址：`grafana.internal/d/api-latency`，这是 oncall 的主要看板。

## 回滚流程

如果部署后发现问题需要回滚：
1. 停止当前服务：`pm2 stop all`
2. 切回上一个版本：`git checkout v1.2.3`
3. 重新安装依赖并构建：`pnpm install && pnpm build`
4. 回滚数据库（如有迁移）：`pnpm db:rollback`
5. 重启服务：`pm2 start ecosystem.config.js`

注意：数据库回滚可能会丢失新版本写入的数据，回滚前需要评估影响。
