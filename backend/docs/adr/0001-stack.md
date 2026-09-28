# ADR-0001：后端技术栈与批量内容处理边界

- 状态：已确认
- 日期：2026-09-24

## 决策

采用 Node.js 24 LTS、TypeScript、Fastify、PostgreSQL、Redis/BullMQ、MinIO/S3 兼容对象存储、FFmpeg/ffprobe，并为需要 ASR 或强制对齐的任务保留独立 Python Worker。应用通过通用 S3 SDK 访问对象存储，不绑定 MinIO 专用 Node SDK。

业务 API 是控制面；音频和字幕经预签名地址直接分片上传对象存储，由独立 Worker 异步处理。PostgreSQL 不保存大文件本体，Redis 队列不作为内容事实来源。

## 原因

- 与现有 JavaScript 工程共享语言和契约工具；
- Fastify 适合清晰的请求校验和插件边界；
- PostgreSQL 提供版本、发布和审计所需的事务与约束；
- BullMQ 支持任务重试、并发和死信处理；
- S3 兼容接口允许本机 MinIO 与未来云存储之间保持适配层；
- FFmpeg/ffprobe 负责可复现的媒体探测和处理，计算密集的语言任务可单独扩容。

## 约束

- `publishable:false` 不能由 Worker 自动提升；
- 生产云厂商、地域、预算和托管服务仍需单独确认；
- API 不代理整文件，不把预签名地址或密钥写入普通日志；
- 每个任务必须幂等，内容版本必须原子发布并可回滚。
