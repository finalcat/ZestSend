# 图文聊天本地验收记录

2026-11-06，基于 `e2c1532` 的未提交工作区。仅本地实现与验收；未提交、推送、部署或创建云端资源。保留原有 `AGENTS.md` 双账号规则、README/CONTRIBUTING 规则入口及 `.idea/` 内容。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | Worker 25/25、客户端 61/61，共 86 项通过 |
| `pnpm check` | 通过，包含应用、Worker 和客户端测试类型检查 |
| `pnpm exec tsc -p tsconfig.e2e.json` | 通过 |
| `pnpm exec tsc -p tsconfig.test.json` | 通过 |
| `pnpm build` | 通过；保留现有大包体积提示 |
| `git diff --check` | 通过 |
| 完整 Playwright 回归 | **22/22 通过，约 3 分钟**；新增 9 项与原有 13 项一起运行 |

浏览器使用 `pnpm build` 之后的 `pnpm preview --host 127.0.0.1 --port 8787`，地址为本地 HTTP 回环地址。运行命令：

```bash
pnpm exec playwright test --config playwright.config.ts --output output/playwright/chat-images-acceptance
```

[浏览器报告与截图附件](../output/playwright/report/index.html)。这些本地诊断产物由 Git 忽略，不提交到仓库。

## 验证范围

- 中英文、深浅主题、375×812 窄屏；右上角无分享/退出，保留房间和步骤及折叠；底部退出可用、状态入口移除、旧 `#status` 回聊天。
- 真实本地 Worker、DO 和 R2 模拟：图文顺序、三种插图入口、拖动排序与删除、草稿保留、IME、Enter/Shift+Enter、纯文本和纯 GIF、单人上传后向后加入者投递。
- 2048 像素压缩、透明背景、全草稿原图切换、GIF 原字节保留；预览和下载 SHA256 与实际上传一致。
- 上传失败重试、重复正文去重、ICE 重建后历史图片继续预览且不重复上传/下载；读取失败与过期占位。503/410 故障用例定向注入响应，其余图片请求走真实本地接口。
- 席位/token 鉴权、独立读凭证、类型与文件签名、实际字节上限、并发/次数/字节额度、分页清理；上传不会更新信令身份或续租，旧图读取不依赖当前席位。
- 真实上传后以假时钟检查截止前 1ms 可读、精确 24 小时截止返回 410；对象尚未删除或清理失败时仍不可读，随后回收未发送正文的孤立对象，删除后仍返回 410。
- 既有首次连接、刷新、信令短断、ICE 失败、同时重启、协作和音视频、大文件完整性及租约过期后保持原 PC/传输的回归。

本地未配置 TURN 生产凭证，本记录不证明跨网络 TURN 中继或生产云端配置已生效。

## 发现与修复证据

客户端新增测试发现并修复：上传队列应在发请求前拒绝超大文件，410 后包括手动重试都不得重新请求同一图片。另修复部分上传成功后过期重试会重新上传，以及 SPA 切换房间可能沿用旧消息的问题。

单人聊天时展开的连接卡片原先会挡住发送按钮；[修复前截图](../output/playwright/solo-debug.png) 保留现场。现在编辑或选图时自动折叠，独立 GIF 排队用例验证发送按钮可直接使用。新图片删除按钮也修正了浅色主题下的颜色对比。

浏览器回归还修正了测试自身的问题：新编辑器/选图框使旧通用定位不再唯一；浏览器 File 上传不能依赖 Playwright 的 `postDataBuffer()` 采样；切换工作区不能将退出动画中的旧编辑器视为当前聊天。旧失败现场保存在 `output/playwright/e2e-results/`、`chat-images-results/` 和 `chat-images-verified/`，包含错误上下文、截图及 trace。新采样仅记录图片名称、类型、大小及摘要，诊断 JSON 不输出房间或图片凭证。

## 部署边界

图片云端能力尚未上线。下一步须按 [图片部署说明](cloudflare-chat-images.md) 在确认的目标账号创建私有桶、配置一天生命周期，再部署 Worker binding 与小时 Cron。本次未更改两个 Cloudflare 账号及其现有资源；聊天历史仍仅保存在当前页面内存。
