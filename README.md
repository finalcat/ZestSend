# ZestSend

ZestSend 是一个开源的 WebRTC 点对点连接网页工具，可自行部署在 Cloudflare 上。

支持文字与图片混排的实时聊天、文件互传、语音通话、视频通话、屏幕共享、同播共享、文本协作、画板等功能。文字、普通文件和媒体通过 WebRTC 端对端加密传输，支持直连或 Cloudflare TURN 中转。

聊天图片通过 HTTPS 上传到 Cloudflare 私有 R2 存储，24 小时后过期，**不采用端对端加密**。图片读取需要独立随机凭证，四位房间号本身不能读取图片；部署运营方能够访问云端图片。聊天历史只保存在当前页面内存，刷新或关闭后清空，云端图片不会恢复聊天历史。

无需注册产品账号，两位参与者输入相同的四位房间号后即可连接。服务器保存必要的短期席位、上传额度和临时图片，部署平台也可能产生运行日志；不承诺“无任何数据记录”。图片使用方式、保留期限及部署要求见 [聊天图片与 Cloudflare 配置](docs/cloudflare-chat-images.md)。

延续并改进了 [RavelloH/TimePulse](https://github.com/RavelloH/TimePulse) 的玻璃态设计美学。

## 部署

本仓库同时使用两个 Cloudflare 账号。检查配置、部署或线上验收前，请先阅读 [双账号部署与验收规则](AGENTS.md)，核对账号、Worker、环境和完整域名。

启用聊天图片前，必须在目标账号创建私有 R2 桶 `zestsend-chat-images`，配置 `CHAT_IMAGES` binding、一天生命周期兜底和小时 Cron；具体步骤见 [图片部署说明](docs/cloudflare-chat-images.md#上线前配置)。部署状态及验证结果需以目标账号的部署记录和验收报告为准。

Fork 本仓库后，在 Cloudflare Dashboard 的 **Workers & Pages** 中依次选择 **Create application** → **Import a repository**，选择自己的 Fork 并完成 GitHub 授权。

在部署设置中保留 Worker 名称为 `zestsend`（需与 `wrangler.jsonc` 一致），选择 `main` 作为生产分支，并设置：

| 配置 | 值 |
| --- | --- |
| Package manager | `pnpm` |
| Build command | 留空 |
| Deploy command | `pnpm deploy` |

### 可选：配置 Cloudflare TURN

未配置 TURN 时，应用仍会使用公共 STUN 尝试直连；如需在受限网络中使用中继，请先在 Cloudflare Dashboard 的 **Realtime** → **TURN** 创建凭证，然后在已部署 Worker 的 **Settings** → **Variables and Secrets** 中添加两个 **Secret**：

| 名称 | 值 |
| --- | --- |
| `TURN_ID` | TURN 凭证的 Key ID |
| `TURN_TOKEN` | TURN 凭证的 API Token |

后续更新时，在 GitHub 通过 **Sync fork** 拉取上游提交并合并到 `main`；Cloudflare 会自动构建并部署。

## 预览

前往 https://send.ravelloh.com 查看效果。

<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/c842bdce-a80c-4760-947d-b601b1023b1f" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/578cf5c6-5ec1-4ba5-a490-a3052cc9bc25" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/90ba302f-a5ed-4e9a-98c0-f2fcc2f0484a" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/ea9522f1-e074-4d6b-8d4c-26963523d044" />
<img width="2560" height="1528" alt="image" src="https://github.com/user-attachments/assets/db5058f0-96ab-43f2-bbea-802ada0e25f1" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d8524922-8792-45c1-9196-36585af365b2" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d3fd6f95-285a-49be-9c59-d6ae7a63ed3e" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/a9c5cde1-74f1-4b72-9bdc-4c4e3a484d1b" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/6004e9f8-8b6e-4fee-99e8-000107e96524" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/5fdd10e9-b273-4c8d-a5d1-5f579ec4cd91" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/808932dc-671d-4dec-9a3a-8ac7e08282e0" />



## 技术栈

- Cloudflare Workers、Durable Objects、Realtime TURN、私有 R2 临时图片存储
- Hono、Wrangler、Cloudflare Vite Plugin
- 原生 WebRTC 的 `RTCPeerConnection`、`RTCDataChannel`、MediaStream
- React、Vite、TypeScript、Tailwind CSS、TanStack Router
- Tiptap、Yjs
- Framer Motion

## 本地开发

```bash
pnpm install
pnpm dev
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

可选的 Cloudflare TURN 配置写入 `.env`：

```dotenv
TURN_ID=your_cloudflare_turn_key_id
TURN_TOKEN=your_cloudflare_turn_api_token
```

未配置 TURN 时，应用仍会使用公共 STUN 尝试直连；受限网络无法穿透时则不会启用中继。

`pnpm dev` 使用本地模拟的 R2 binding，无需创建真实云桶或填写 R2 S3 密钥；本地图片与云端图片相互独立。本地 Cron 不会自动按小时运行，测试与清理验证方式见 [图片本地开发说明](docs/cloudflare-chat-images.md#本地开发与验证)。

## 许可证

本项目采用 [MIT License](LICENSE)。
