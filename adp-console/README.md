# ADP 智能体应用控制台（DSH 插件）

在 Harness Web UI 里查看腾讯云 ADP（智能体开发平台）上**已发布**的智能体应用清单，
用「上架 / 下架」控制哪些应用可以被 DSH 调用，并对已上架的应用直接发起 ADP 会话。

侧边栏面板名：**ADP 智能体**（面板 id `adp`）。

---

## 1. 它做什么

| 能力 | 说明 |
| --- | --- |
| 应用清单 | 调用 ADP `DescribeAppSummaryList`，默认只列**已上线（已发布）**的应用，支持模糊搜索与状态筛选 |
| 上架 / 下架 | 插件本地的 **DSH 调用开关**。上架 = 允许 DSH 通过 ADP 会话接口调用该应用；下架 = 禁止 |
| 发布到 ADP | 对尚未成功发布的应用调用 `CreateRelease` 并轮询 `DescribeLatestRelease` 直到任务终态 |
| 会话 | 对已上架的应用调用 ADP 会话接口（SSE 优先，查不到应用时自动回退 WebSocket），面板里流式显示回复 |
| Agent 工具 | 向模型暴露 4 个工具，Agent 也能列清单、切换开关、发布、对话 |

### 关于「上架 / 下架」的准确语义

按你的澄清，**上架 / 下架 = 控制这个 ADP 应用能否被 DSH 调用**（用「启用 / 停止」更贴切），
它是一个**插件侧**的开关，**不会**改变应用在 ADP 平台上的状态。

补充一个调研结论：ADP 公开 API（`adp` / Version `2026-05-20`）**没有**「下架 / 取消发布 / 停用应用」的接口。
`发布管理相关接口` 只有 新增发布（`CreateRelease`）／查询发布（`DescribeReleaseSummary`）／发布记录
（`DescribeReleaseList`）／回滚发布（`RollbackRelease`）／重试发布（`RetryRelease`）／拉取最新发布
（`DescribeLatestRelease`）／Agent 发布预览；`应用管理相关接口` 只有应用增删改查 + 渠道
（渠道也只能改备注和企微机器人 ID）。已发布应用在平台侧的下线仍需到 ADP 控制台操作。

---

## 2. 安装状态

已经安装到当前 profile（desktop）：

```
$DSH_PROFILE_DIR/package.json → dependencies["@local/adp-console"] = link:<本目录>
$DSH_PROFILE_DIR/package.json → dsh.profile.bundles 包含 "@local/adp-console"
```

重新安装（包名写法，因为目录依赖已存在，用目录路径会报 `ambiguous-install`）：

```
plugin_manager install_bundle  target: @local/adp-console
```

改完 Host 代码后，若 `install_bundle` 返回 `restart-required`，用下面这招热重载（实测有效，无需重启 Harness）：

```
plugin_manager set_bundle  enabled: false  target: @local/adp-console
plugin_manager set_bundle  enabled: true   target: @local/adp-console
```

---

## 3. 选择站点并配置密钥

ADP 有三种部署形态，**接口域名和密钥来源都不同**，密钥只属于其中一个站。选错站点的表现是
`AuthFailure.SecretIdNotFound`（或独立站的 `450203-ErrSecretNotFound`），看起来跟密钥被删掉一模一样。

| 站点 | 接口域名 | 密钥来源 |
| --- | --- | --- |
| **独立站** | `capi.adp.tencent.com` | [ADP 控制台 → 密钥管理](https://adp.tencent.com/adp#/key-manage) |
| 中国站 | `adp.tencentcloudapi.com` | [腾讯云 CAM 控制台](https://console.cloud.tencent.com/cam/capi) |
| 国际站 | `adp.intl.tencentcloudapi.com` | 国际站控制台 |

三个站**共用同一套 API**：同样的 Action、同样的 `2026-05-20` 版本、同样的 V3 签名、
同样的 `ap-guangzhou` 地域，只有域名和密钥来源不同。见
[API 接入操作指南 · 概览](https://cloud.tencent.com/document/product/1759/133868) 与
[从零搭建一个 Claw 模式应用](https://cloud.tencent.com/document/product/1759/133869)：

```python
# 腾讯云用户使用 adp.tencentcloudapi.com；独立站用户替换为 capi.adp.tencent.com
profile = ClientProfile(httpProfile=HttpProfile(endpoint="adp.tencentcloudapi.com"))
client = adp_adp_client.AdpClient(cred, "ap-guangzhou", profile)
```

本仓库的 `cordis.patch.yml` 已把站点设为 `standalone`（独立站）。切换站点：
面板「设置」→「站点」，或改 `cordis.patch.yml` 里的 `site`。

密钥来源，**优先级从高到低**：

1. **面板里填写**（推荐）：面板 → 右上「设置」→ 填 SecretId / SecretKey / 站点 / 地域 / 空间 ID → 保存。
   密钥写入 `<DSH_HOME>/adp-console/state.json`，文件权限 `0600`，**不会**回传给浏览器；**换密钥不需要重启**。
2. **插件 config**：`cordis.patch.yml` 里 `adp-console` 这一行的 `config.secretId` / `config.secretKey`。
3. **环境变量**：`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`。

默认值：地域 `ap-guangzhou`（该产品公开地域只有广州），空间 ID `default_space`。

---

## 4. Agent 工具

| 工具 | 作用 |
| --- | --- |
| `adp_list_apps` | 列出应用（含 ADP 发布状态与本插件上架状态） |
| `adp_list_spaces` | 列出这把密钥能看到的真实 SpaceId（空间名字 ≠ SpaceId） |
| `adp_set_app_enabled` | 上架（启用）/ 下架（停止）某个应用 |
| `adp_publish_app` | 在 ADP 上新增发布任务并轮询到终态 |
| `adp_chat` | 对**已上架**的应用发一条消息，返回完整回复；未上架会明确拒绝 |

---

## 5. 浏览器通道

> **主题 token 必须成对使用。** 面板最初的用户气泡和主按钮写的是
> `background: var(--dsw-alias-brand-primary); color: #fff`。但主题里
> **light 的 `brand-primary` 是近黑（neutral-bluish-1000），dark 的却是近白（neutral-bluish-50）**，
> 于是暗色模式下白字压白底 —— 气泡和发送按钮上的文字全部看不见。
> 宿主自己的主按钮用的是配对 token：
> ```css
> .primary { background: var(--dsw-alias-button-primary-fill);
>            color: var(--dsw-alias-label-primary-foreground); }
> ```
> `--dsw-alias-label-primary-foreground` 在 light 是白、dark 是黑，正好随主题翻转。
> 本插件的用户气泡、主按钮、开关旋钮与轨道现已全部改用宿主同款配对
> （`button-primary-fill` / `label-primary-foreground` / `brand-primary` / `border-l3`），
> **样式里不再有任何字面颜色**；自测里有一条守卫同时检查「无字面颜色」与「配对 token」。

> **冷启动必须用 `ctx.inject(['webServer'], …)` 注册路由**。最初这里写的是
> `const webServer = ctx.get('webServer')`，一次性取值 —— 插件在冷启动时比 HTTP 载体先激活，
> 于是 `webServer` 是 `undefined`，路由被**永久跳过**，面板就只剩 404（现象就是「访问不到 ADP」）。
> 我此前的验证全靠 `set_bundle` 热切换（那时服务早已就绪），所以一直没暴露。
> 现在改成作用域注入：服务出现时注册，服务消失时随之释放。自测里有一条正是这个冷启动竞态。

面板通过同源路由 `<routePrefix>`（默认 `/adp-console`）访问 Host 侧：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /adp-console/config` | 配置概览（密钥只回掩码） |
| `POST /adp-console/config` | 保存 / 清除密钥（`{clear:true}` 清除，`{site:'cn'\|'intl'}` 切站点） |
| `GET /adp-console/apps` | 应用清单（`query` / `status` / `pageSize` / `pageNumber`） |
| `GET /adp-console/spaces` | 这把密钥能看到的真实 SpaceId 列表 |
| `POST /adp-console/enabled` | 上架 / 下架 `{appId, enabled}` |
| `POST /adp-console/release` | 发布 `{appId, description?}` |
| `POST /adp-console/release-status` | 查询最新发布状态 |
| `POST /adp-console/verify` | 凭据体检：分别探测 身份核对 / 当前站点 ADP / 国际站 ADP，给出归因结论 |
| `POST /adp-console/chat` | 会话，返回 `text/event-stream`（`console.delta` / `console.done` / `console.error` / `adp.event`；`console.done` 带 `transport`） |

路由只接受 loopback 的 `Host`，因此不接受浏览器跨站请求；密钥永不出现在页面里。

---

## 6. 自测

不需要腾讯云凭证，也不联网：本地起一个 mock ADP 网关，把真实 Host 代码整条链路跑一遍。

```bash
cd adp-console
node test/self-test.mjs      # 49 项断言
```

覆盖：TC3 签名（对齐腾讯云官方文档 cvm 示例的签名值）、工具注册、路由注册、
清单查询与过滤、上架/下架落盘与 0600 权限、SSE 增量与终态文本不重复、未上架时
工具与路由双双拒绝、面板侧保存密钥、无密钥时的明确报错、凭据体检的三种归因结论、
站点切换。

### 凭据排障

```bash
node test/diagnose.mjs                  # 用已保存的密钥把三个站各实打一遍，只打印掩码
DSH_ADP_SITE=standalone node test/diagnose.mjs
```

三种鉴权失败长这样，含义完全不同：

| 现象 | 含义 |
| --- | --- |
| 腾讯云站 `AuthFailure.SecretIdNotFound` | CAM 不认识这个 SecretId：密钥写错/被删，或它其实来自独立站 |
| 独立站 `FailedOperation: 450203-ErrSecretNotFound` | 独立站不认识这个密钥：请用 [ADP 密钥管理](https://adp.tencent.com/adp#/key-manage) 的密钥 |
| 身份核对通过、ADP 被拒 | 密钥有效但账号没开通 ADP / 不在该空间 / 缺权限 |

面板「设置」里的「检测凭证」按钮给的就是同一份结论（要 Harness 重启后才出现，见下）。

## 7. 验证状态（请如实看待）

| 项 | 状态 |
| --- | --- |
| 自测 83 项 | 通过 |
| TC3 签名 vs 官方文档向量 | 逐字节一致 |
| `capi.adp.tencent.com` 连通性 | **已实测**：请求被接受并返回独立站自己的业务错误格式 `450203-ErrSecretNotFound` |
| `adp.tencent.com/adp/v2/chat` 对话端点 | **已实测**：`200 text/event-stream`，返回标准 `error` 事件 |
| 腾讯云站 / 国际站连通性 | **已实测**：返回 `AuthFailure.SecretIdNotFound` |
| 线上实例已切到独立站 | **已确认**：`endpoint=capi.adp.tencent.com`、`chatEndpoint=https://adp.tencent.com/adp/v2/chat`、`wsEndpoint=wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/` |
| 线上路由 `/adp-console/*` | **已实测 200**（冷启动竞态修复后） |
| 线上工具注册（4 个） | 已确认 |
| 线上路由 `/config` `/apps` `/enabled` `POST /config` | 已确认 |
| 线上客户端面板两个 slot（`sidebar.panellist` + `main`） | 已确认注册且 active |
| 面板实际渲染 | **未验证**：读不到浏览器控制台，需你刷新页面点开面板确认 |
| 真实 ADP 清单 | **已实测通过**：独立站 `capi.adp.tencent.com` 返回真实应用 `clawagent_demo`（ClawAgent 模式，运行中） |
| 真实上架 / 下架 | **已实测通过**：开关写入 `state.json` 并在重新拉取后保持 |
| 真实会话 | **已打通**：SSE 报 `460004` 时自动回退 WebSocket，4.1s 拿到真实回复 |

### 接口用法已逐条比对官方文档 —— 结论：用法正确

对照 [对话端接口文档（HTTP SSE）](https://cloud.tencent.com/document/product/1759/129202) 与
[从零搭建一个 Claw 模式应用](https://cloud.tencent.com/document/product/1759/133869)（用官方 PDF 全文核对，
HTML 页在这些章节前就被截断）：

| 文档要求 | 插件实际 | |
| --- | --- | --- |
| 独立站管理域名 `capi.adp.tencent.com` + V3 签名 | 一致 | ✅ |
| 独立站对话端点 `https://adp.tencent.com/adp/v2/chat` | 一致 | ✅ |
| 对话端点用 AppKey 鉴权、**无需 V3 签名** | 一致 | ✅ |
| body：`RequestId` / `ConversationId`(32-64, `^[a-zA-Z0-9_-]{32,64}$`) / `AppKey` / `Contents:[{Type:"text",Text}]` / `VisitorId` / `Incremental` / `EnableMultiIntent` / `Stream` | 一致（另按参数表补发 `UserId`，文档标「是」） | ✅ |
| `ConversationId` 需先由 `CreateConversation(Type=5, AppId, AppKey, UserId)` 取得 | 一致 | ✅ |
| 前置条件「需要有已发布的应用」 | `Status=3 发布成功` | ✅ |

**最直接的证据**：把文档 §1.3 的原版 curl **原样**执行（只替换 `AppKey` 与 `ConversationId`）：

```bash
curl --location --request POST 'https://adp.tencent.com/adp/v2/chat' \
  --header 'Content-Type: application/json' \
  --data '{ "RequestId": "4feb312a-14e9-4161-bfe2-767c43ae0524",
            "ConversationId": "5c1e41a4-9d27-4f28-a621-bf3ccfb96439",
            "AppKey": "<真实 AppKey>",
            "Contents": [{"type":"text","Text":"你好"}],
            "VisitorId": "100015179581",
            "Incremental": true, "EnableMultiIntent": true, "Stream": "enable" }'
```

返回：

```
event: error
data: {"Type":"error","Error":{"Code":460004,"Message":"机器人不存在", ...}}
```

**用文档自己的请求也报同样的错**，所以这不是插件的用法问题。

### 会话已打通：SSE 不可用时自动回退到 WebSocket

**最终解法**：ADP 还有一条文档化的 **WebSocket 会话通道**（[对话端接口文档（WebSocket）](https://cloud.tencent.com/document/product/1759/129365)），
它的应用身份由 `CreateWebSocketToken(Type=5, AppId, AppKey, UserId)` 签发的 token 携带，**不走 SSE 那条查表的路径**。
本插件默认 `chatTransport: auto`：**先走文档主推的 SSE，只有在 SSE 报「应用不存在」时才自动回退到 WS**。

实测对真实的 `clawagent_demo`：

```
SSE  → 460004 机器人不存在（对话服务查不到该应用）
WS   → ✅ 4.1s 拿到完整回复，33 个事件，transport: ws

回复：你好！我是 Claw Agent，一个能帮你查资料、写文档、处理数据、做图表、搭网页、写代码的
      自主智能体——有什么需要，尽管吩咐。
```

WS 握手（按文档实现，Socket.IO v4）：

```
① 连接 wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/?language=zh-CN&EIO=4&transport=websocket
② 服务端 0{"sid":...}           → 客户端发 40{"token":"<CreateWebSocketToken 的 Token>"}
③ 心跳   服务端 2               → 客户端回 3（不回会被断线）
④ 请求   42["request",{"Type":"request","Request":{RequestId,ConversationId,Contents,...}}]
⑤ 事件   42["text.delta",{...}] 与 SSE 同一套事件词汇，复用同一个归约器
```

回退策略很克制：`460048 应用未发布`（WS 也救不了）和网络类失败**不会**触发回退，只有
`460004`/`460033`（对话服务查不到应用）才回退。可用 `chatTransport: sse|ws|auto` 强制指定。

### 顺带修掉的两个真 bug

1. **`message.added` 的判别字段是 `Message.Type`（`thought`/`reply`），不是 `MessageType`**。
   实测抓到的结构是
   `{"Type":"message.added","MessageId":"msg_…_1_reasoning","Message":{"Type":"thought","Name":"思考",…}}`。
   之前按 `MessageType` 判断，导致**思考过程被当成回复**。
2. WS 通道的 `message.added` 同样按 `Message.Type` 判别，已用真实帧形状写进自测。

### 为什么 SSE 会「应用不存在」——已定位为平台侧登记缺陷

`460004` 在[对话端接口文档 §4 错误码](https://cloud.tencent.com/document/product/1759/129202)里的定义是**应用不存在**
（不是「AppKey 无效」，后者的专用码是 `4505004`，我们没收到）。

**关键对照实验**（空间里恰好有两个应用，同一客户端、同一密钥、同一空间、同一代码路径）：

| 时刻 | `会议纪要助手`（AppId 2104586751524016960） | `clawagent_demo`（AppId 2104560982848278656） |
| --- | --- | --- |
| 发布前 | `460048 应用未发布` ← 对话服务**认识**它 | — |
| 调 `CreateRelease` 后 `Status=3 发布成功` | **`460004 机器人不存在`** ← 变得**不认识**了 | `460004`（一直是） |

对比前后 **AppKey 完全没变**（`ytmloW…KKuX`），`CreateConversation` 两次都成功。

**结论**：在独立站上，「未发布」的应用对话服务是认识的（能准确回 `460048`），一旦发布成功，
反而变成查不到（`460004`）。也就是说**发布没有把这个应用的机器人登记到对话服务**，而返回的
`Status=3 发布成功` 只代表管理面成功。这是平台侧缺陷，不是本插件的用法问题。

**为什么能确定不是用法问题**：把官方文档 §1.3 的原版 curl 原样执行（只替换 `AppKey`/`ConversationId`）
也返回同样的 `460004`；`AppId` 也已在三处交叉验证正确（列表 / `DescribeApp.Metadata` / 名称），
且空间内没有别的 id 字段。

**建议**：

1. 在控制台对应用**用界面再点一次「发布」**，然后用控制台的「调用」试聊 —— 若控制台发布后才通，
   说明 API 的 `CreateRelease` 少了控制台做的登记步骤。
2. 若控制台也调不通，按下面的材料提 ADP 工单。

> 工单材料：独立站（管理域名 `capi.adp.tencent.com`，对话端点 `https://adp.tencent.com/adp/v2/chat`）。
> 空间 `bfnUUoSh`。应用 `会议纪要助手`（AppId `2104586751524016960`）与 `clawagent_demo`
> （AppId `2104560982848278656`）均已 `Status=3 发布成功`、应用状态「运行中」、各有 1 个主 Agent。
> 现象：`POST https://adp.tencent.com/adp/v2/chat`（AppKey 鉴权，按文档 §1.3 原版 curl）返回
> `460004 机器人不存在`。对照：`会议纪要助手` 发布**前**同一个请求返回 `460048 应用未发布`，
> 发布后变成 `460004`，AppKey 前后未变。说明发布未在对话服务登记该机器人。
> TraceId 示例：`90defac5d2f5db90eb32442f653dff42`、`74aa08271df2eb975bc487e4b4876f1c`。

### 已经排除的原因（全部实测）

| 试过的做法 | 结果 | 结论 |
| --- | --- | --- |
| `Domain=1` / `Domain=2` / 不传 Domain 取 AppKey | 三者同一把 | 不是域的问题 |
| 独立站 `adp.tencent.com` 与云站 `wss.lke.cloud` | 两边都 `460004` | 不是端点选错 |
| 只发 `VisitorId` / 同时发 `UserId` / 补 `AgentId`/`AppId`/`SpaceId` | 都 `460004` | 不是字段问题 |
| 旧版 LKE 字段名 `BotBizId`/`BotAppKey` | `400` 或 `460004` | 不是字段名问题 |
| 自造 ConversationId | `460004` | 不是会话来源问题 |
| **`CreateConversation(Type=5, AppKey, UserId)` 后再对话** | `460004` | 已按文档步骤 6 做，仍不通 |
| 给 `capi.adp.tencent.com/adp/v2/chat` 加 V3 签名 | `401` → `500` | 该地址是管理网关，不是对话端点 |
| **`AppKey` 乱填后调 `CreateConversation`** | `400 请求参数错误` ✅ 被拒 | **反证：管理侧认可这把 AppKey 且绑定到该应用** |
| `AppKey` 填成 AppId | `4505004 应用密钥无效` | 我们的 AppKey 形状是对的 |

其余事实：发布 `Status=3 发布成功`；应用 `Status=2 运行中`；`DescribeAgentSummaryList` 有 1 个主 Agent
（`386a4fe8-bac9-4a62-b649-a5cad6d63a06`）；`DescribeChannelList` 为 0（查证后确认**渠道对话接口无关**，
官方 `DescribeLatestRelease` 示例本身就是空 `ChannelIdList` + `Status=3`）；`AppShareAccessControl` 解出来是
`PUBLIC`，不是限制；AppKey 是 128 位 base64url 不透明串，不含 AppId/SecretId。
`AppMode=4`(ClawAgent)、`AgentId` 只是 `CreateConversation` 入参、`CreateWebSocketToken` 的 Token 仅用于 WS 握手
——这些也已逐条排除。

排障脚本：`node test/chatprobe.mjs <appId>`、`node test/appkey.mjs <appId> [--chat] [--dump]`、
`node test/spaces.mjs`。

### 独立站与腾讯云站的差异（已确认）

除了管理域名和密钥来源，**对话端点也不同**，[从零搭建](https://cloud.tencent.com/document/product/1759/133869) 的原文是：
*「对话流接口与腾讯云接口不同：走独立域名、用 AppKey 鉴权、以 SSE 流式返回（**无需 V3 签名**）。」*

| | 腾讯云站 | 独立站 |
| --- | --- | --- |
| 管理 API | `POST https://adp.tencentcloudapi.com/` | `POST https://capi.adp.tencent.com/` |
| 对话 SSE | `https://wss.lke.cloud.tencent.com/adp/v2/chat` | `https://adp.tencent.com/adp/v2/chat` |
| 端点鉴权 | AppKey | AppKey（同样不需要 V3 签名） |

实测（各发一个假 AppKey）：

| 地址 | 响应 |
| --- | --- |
| `https://adp.tencent.com/adp/v2/chat` | `200 text/event-stream` → `event: error` `4505004 应用密钥无效` ✅ 就是独立站对话端点 |
| `https://wss.lke.cloud.tencent.com/adp/v2/chat` | `200 text/event-stream` → `4505004 应用密钥无效`（云站端点，对独立站应用无效） |
| `https://capi.adp.tencent.com/adp/v2/chat` | `401 40101-missing Authorization header` ← 管理网关，**不是**对话端点 |

对话请求体上，腾讯云文档用 `UserId`、独立站文档用 `VisitorId`；插件**两个都发**，一套代码两边都能用。
`ConversationId` 两边都必填，插件始终自动生成。

独立站文档没有列出 SSE 的 `error` 事件，但实测确实会返回 `{"Type":"error","Error":{"Code":4505004,...}}`；
插件的解析器按实际行为处理，不依赖文档是否收录。

**关于热更新**：`install_bundle` 对已安装的包返回 `restart-required`；
`set_bundle` 关→开只会重跑 `apply`，**不会**重新 import 模块。所以 Host 侧的新代码
（`site` 站点选择、`/verify` 凭据体检、鉴权报错文案）要等 Harness 重启后才生效。
凭据本身是每次调用现读状态文件的，**换密钥不需要重启**。

## 8. 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单（`dsh.bundle.patch` + `dsh.client`），无任何运行时依赖 |
| `cordis.patch.yml` | profile 里插入的那一行 |
| `index.js` | Host 半：TC3 签名、ADP OpenAPI 客户端、上架开关、4 个工具、浏览器路由、SSE 解析 |
| `client.js` | Client 半：侧边栏图标 + 主面板页面 + 流式会话 |
| `locale/zh.json`、`locale/en.json` | 插件卡片的标题与描述 |
| `icon.svg` | 侧边栏与插件卡片图标 |
| `test/self-test.mjs` | 自测（不随 bundle 发布） |

**注意**：Host 半刻意不 import 任何 Harness 包。工作区 bundle 无法解析
`@deepseek-ai/*`（profile 的 `node_modules` 里只有你自己的包），所以本插件只用
Node 内置模块；配置默认值在 `index.js` 的 `DEFAULT_CONFIG` 里，运行期需要用户调整的
东西都放在面板的「设置」里。
