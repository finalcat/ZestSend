# 聊天图片与 Cloudflare 配置

聊天图片使用 HTTPS 和私有 Cloudflare R2 临时存储；文字、普通文件、通话等继续使用 WebRTC。仓库配置已加入图片能力。部署时必须先核对目标账号的私有桶、生命周期与 Worker binding；实际部署状态以该目标的验收记录为准。本地测试通过不代表生产站点已经可用。

## 数据流与保留期限

| 内容 | 传输与保存方式 |
| --- | --- |
| 文字、普通文件、语音、视频及其他 WebRTC 功能 | WebRTC 端对端加密；可直连或经过 TURN 中继 |
| 聊天图片 | HTTPS 上传至私有 R2，再通过 Worker 凭证鉴权读取；不采用端对端加密，部署运营方能够访问图片 |
| 图文消息正文与图片读凭证 | 通过双方 WebRTC 聊天通道发送；图片引用就绪后才发送正文 |
| 聊天历史与预览缓存 | 当前页面内存；刷新或关闭后清空，不从 R2 恢复历史 |

图片支持选图、粘贴和拖拽，按文字段落和图片块混排。Enter 发送，Shift+Enter 换行；默认尝试自动压缩，可选择原图。支持 JPEG、PNG、WebP、GIF，单张源文件及上传文件不超过 20 MiB，单条消息最多 10 张、合计不超过 50 MiB。默认压缩最长边为 2048 像素，尝试 WebP 编码；GIF 保持动画，压缩未能减小文件时保留原文件。

服务端在接收上传时生成固定的 24 小时截止时间。上传后未发送、发送前删除草稿或丢失响应的图片同样按原截止时间清理；重连、查看及消息重发不会续期。图片到期后，Worker 读取接口返回 HTTP 410，页面显示“图片已过期”。已经下载或保存到接收方设备的副本无法撤回。

“24 小时过期”是访问截止时间。物理删除由小时 Cron 执行，通常在后续整点完成；R2 一天生命周期是清理失败时的兜底，不保证精确到时删除。Cloudflare 说明生命周期删除存在延迟，详见 [R2 对象生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

应用无需注册产品账号，但服务器会保存短期席位、上传限额和临时图片，Cloudflare 也可能根据部署配置保留运行日志。因此不得将整个产品描述为“不经过服务器”“不存储任何数据”或“全部内容端对端加密”。

## 接口与访问边界

`POST /api/rooms/:roomId/chat-images` 上传二进制图片，以 `Authorization: Bearer <当前 resumeToken>` 验证已有房间席位。请求使用图片 MIME 和 `X-Image-Name: encodeURIComponent(name)`；浏览器直接发送 File/Blob，自动提供 `Content-Length`。Worker 验证实际字节数与图片签名，通过 R2 binding 写入，不需要额外的 R2 S3 access key。

成功响应包含 `imageId`、`readToken`、`expiresAt`、`mimeType` 和 `size`。`expiresAt` 是服务端 Unix 毫秒时间；`imageId` 包含该截止时间。宽高、显示名称和原图标记由前端补充到 P2P 正文中。

`GET /api/chat-images/:imageId` 使用独立的 `Authorization: Bearer <readToken>` 读取图片，不凭四位房间号或房间成员身份放行。读凭证由 32 字节随机值生成，服务端仅保存其 hash。客户端通过 fetch 取得 Blob 后生成预览 URL，不将读凭证放入图片链接、查询参数或日志。图片响应及接口错误使用 `Cache-Control: private, no-store`，不经过公开 R2 域名或公开 CDN 缓存。

上传额度按房间稳定席位计算：最多 2 个并发上传、每分钟 20 次上传申请、每小时 200 MiB。额度在 DO 中原子预留，完成或失败后释放并发占用；重新建立同一席位的 WebSocket 不重置额度。此限额不能替代部署方对整体资源用量和费用的监控。

resumeToken 会随信令恢复轮换。鉴权成功的在途上传继续完成；新请求使用旧 token 会返回 401，客户端等待最新 welcome 后重试一次。席位过期但 P2P 仍健康时，文字通道和未过期图片读取可继续使用；新图片上传需要先恢复有效席位。图片过期、读取凭证错误、超限和上传失败均不清空聊天正文。

## 本地开发与验证

使用 `package.json` 声明的 pnpm 版本安装依赖，然后启动：

```bash
pnpm install
pnpm dev
```

打开 [本地应用](http://127.0.0.1:8787)。Cloudflare Vite 插件从 `wrangler.jsonc` 提供本地 R2 模拟，默认不访问生产桶，无需为本地图片配置 S3 密钥。不要启用远程 R2 binding 来替代本地测试。可选 TURN 变量仍按 README 配置；不要提交凭证、图片或本地模拟数据。

```bash
pnpm check
pnpm test
pnpm build
```

Worker 测试使用本地 R2 和真实 DO 测试运行时，覆盖席位鉴权、token 轮换、读凭证、实际文件上限、图片签名、上传额度及 scheduled 清理；客户端测试覆盖协议与消息逻辑。本地 Cron 不会自动按小时执行，Worker 测试显式调用 scheduled handler 验证清理。仅通过这些测试不能替代双浏览器图文发送、真实图片解码和目标域名验收。

## 上线前配置

先阅读并遵守 [Cloudflare 双账号部署与验收规则](../AGENTS.md)。生产目标默认是账号 `1736995`（Account ID `65640594e6a974afde8dc8b6cfdfe935`）下的 Worker `zestsend`，完整域名为 [zestsend.1736995.workers.dev](https://zestsend.1736995.workers.dev)。另一个账号 `family-memo` 下的同名 Worker 仍然有效，不能把 CLI 当前登录账号当作本次生产目标，也不能跨账号套用 R2 桶或验收结论。用户另有明确指定时，以指定目标为准，并重新核对当前状态。

1. 核对 **Account ID、Worker、环境、完整域名**，检查当前提交、线上版本及 GitHub 自动部署状态。CLI 使用任务范围的 `CLOUDFLARE_ACCOUNT_ID` 或已确认的认证 profile，操作结束恢复原设置；不要永久改变全局登录目标。两个账号的桶和绑定各自独立。
2. 在目标账号创建 R2 桶 `zestsend-chat-images`。关闭 `r2.dev` 公开访问，不绑定公开自定义域名。桶供 Worker binding 访问，浏览器始终调用 Worker HTTPS API。
3. 在该桶的生命周期设置中，为前缀 `chat-images/` 添加 **一天后删除对象**的规则。若使用 CLI，先核对账号，再按本仓库 Wrangler 支持的命令执行：

   ```bash
   pnpm exec wrangler r2 bucket lifecycle add zestsend-chat-images chat-images-1-day chat-images/ --expire-days 1
   ```

   也可通过目标账号的 Dashboard 添加该规则。已有生命周期规则需保留，不能为添加图片规则覆盖其他规则。
4. 核对目标 Worker 环境的 `CHAT_IMAGES` binding 指向该账号的私有桶。仓库 `wrangler.jsonc` 已声明桶名和 binding；若使用其他环境，需为该环境单独配置并核对。无需新增 R2 S3 密钥，也不要将读凭证作为全局环境变量。
5. 在目标 Worker 上核对 `0 * * * *` Cron 和导出的 scheduled handler。该表达式按 UTC 每小时整点执行，遍历到期小时前缀并分页删除已过期对象；规则随 Wrangler 配置管理。传播可能有延迟，不能只凭本地 JSON 判断线上 Cron 已生效，参见 [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
6. 云端桶和规则准备完成后，再让包含 R2 binding 的提交进入 GitHub 自动部署流程。若同一提交已自动部署，先核对版本并验收，不重复手动部署；需要手动部署时使用仓库入口 `pnpm run deploy`，保留现有 `--keep-vars`。

生产验收访问目标完整 HTTPS 域名，关闭本地服务器回退，记录账号、环境、提交和 Cloudflare 部署版本。至少使用两个独立浏览器会话验证图文混排、选图/粘贴/拖拽、原图与压缩、刷新或重连后的投递、错误凭证拒绝读取，并在目标桶及 Cron 事件中核对过期清理。不要缩短真实用户图片的期限来代替到期测试。部署成功、配置就绪与功能验收是三个不同结果，需要分别记录。
