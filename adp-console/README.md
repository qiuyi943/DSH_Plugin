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
| 会话 | 对已上架的应用调用 ADP 会话接口（SSE 优先，查不到应用时自动回退 WebSocket），面板里流式显示回复，并渲染 `questionnaire` 等人在回环组件；管理接口走官方 ADP SDK |
| `@` 对话 | 会话输入框里 `@` 一个已上架应用，**这一轮由该应用回答**（走 `llm/stream` 路由，不经过会话模型）：见 [§4.6](#46-在会话里用--与智能体对话) |
| Agent 工具 | 向模型暴露 5 个工具，Agent 也能列清单、切换开关、发布、对话 |

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

## 4.5 官方 SDK

按[从零搭建](https://cloud.tencent.com/document/product/1759/133869)第 2 步「安装 ADP 专属 SDK」，
管理接口改由官方 SDK 承担，插件不再自己拼签名：

```bash
cd adp-console && pnpm add tencentcloud-sdk-nodejs-adp   # 已装好；node_modules 不入库
```

- 插件跑在 **Node 宿主**里，对应的是 Node 版 `tencentcloud-sdk-nodejs-adp`（文档给的是 Python 版
  `tencentcloud-sdk-python-adp`）。
- 一处工程约束：**工作区 bundle 只能从自身目录解析依赖**（`$DSH_PROFILE_DIR/node_modules` 不在
  Node 的解析链上），所以 SDK 必须装在插件目录内，装完 `adp-console/node_modules` 约 3.7 MB（已 gitignore）。
- SDK 只覆盖**管理接口**（`DescribeAppSummaryList` / `DescribeApp` / `CreateConversation` /
  `CreateWebSocketToken` / `CreateRelease` / `DescribeReleaseSummary` …）。**对话流不是 SDK 能力**，
  仍走 HTTP SSE / Socket.IO —— 与文档一致，文档里对话也是用 `requests` + `sseclient` 发的。
- 发布轮询已按文档改用 `DescribeReleaseSummary(AppId, ReleaseId)` 查**指定任务**，
  该 action 不可用时回退 `DescribeLatestRelease`。
- **SDK 是产品专属的**：`adp` 以外的调用（凭据体检里的 CVM 身份核对）仍走内置签名器。
- **没装也能跑**：`import('tencentcloud-sdk-nodejs-adp')` 失败时自动回退到插件内置的 TC3 签名，
  只是少了 SDK 的便利。`useSdk: false`（config）或 `DSH_ADP_NO_SDK=1`（环境变量）可强制内置签名。
- 面板「设置」底部会显示当前生效的是**官方 ADP SDK** 还是**内置 TC3 签名**。

实测（真实应用，两条链路都通，均已拿到真实回复）：

```
官方 SDK      → 完整回复 "OK" · 通道 ws · 6.5s
内置签名回退  → 完整回复 "OK" · 通道 ws · 3.2s
```

## 4.6 在会话里用 `@` 与智能体对话

**一句话**：在任意会话（包括新会话）的输入框里打 `@`，菜单里会多出一个 **「ADP 智能体」** 分组，
列出所有**已上架**的应用；选中一个再发消息，**这一轮就由那个应用回答，而不是由会话模型回答**。

### 它怎么工作（为什么不是「工具调用」）

DSH 的模型调用有一层文档化的中间件：`llm/stream` waterfall
（*"Waterfall around every streaming model call (retry, replay, routing)"*）。
本插件在这里用 ADP 的会话流**直接产出** provider 层的 `StreamChunk`
（`block-start` / `text-delta` / `block-end` / `finish`），于是：

- 没有调用会话模型，也没有把提问转述给模型 —— 回复就是 ADP 应用的原文；
- 回复仍然是一条**普通的助手消息**，照常落进会话日志、照常流式显示、照常可以 fork/回看；
- 单轮里的推理（`thought`）帧依旧被过滤，人在回环表单依旧被解析（见下）。

### 绑定：@ 的是什么，靠什么认出来

prompt 里只留**可读的 `@应用名`**（例如 `@客服助手 帮我看下数据`），而不是一串 id ——
聊天视图会把 `@token` 渲染成 chip，塞进 id 只会显示成一坨原文。
应用 id 走一条**带外的绑定**：

| 时机 | 通道 | 作用 |
| --- | --- | --- |
| 在 `@` 菜单里选中 | `POST /adp-console/bind` | 把 `(会话 → appId)` 记在 Host 内存里，等待下一条消息 |
| 发送 | 会话本身 | 文本只带 `@客服助手 …`；Host 在 `agent/pre-step` 里消费绑定、**删掉 mention**、把消息绑到该应用 |
| 回答 | `llm/stream` | 用绑定的应用发这一轮；ADP 的 `ConversationId` 按 (会话, 应用) 复用 |

三条由此而来的行为：

1. **后续消息不用再 @**：绑定跟着会话走，`再详细点` 依旧发给同一个应用（同一段 ADP 会话）。
2. **手打/粘贴的 `@应用名` 也认**：没有绑定记录时，Host 按「已上架应用名」的索引解析，
   所以把消息复制到另一个会话、或者手敲一遍，同样能路由。
3. **`@DSH` 是出口**：`@` 菜单最后一行「DSH 本体」清掉绑定并删掉 mention，
   这一轮重新交回会话模型。

`@` 菜单只列**同时满足「ADP 已上线」与「插件已上架」**的应用 —— 菜单就等于「DSH 现在能调用谁」。
会话中途下架该应用，下一轮会得到一条说明（「未上架…」）而不是静默失败。

### 人在回环表单

Claw 类应用会用 `AskUserQuestion` 提问，而平台下发的是**没有正文**的 `questionnaire`。
v1 把它渲染成可回答的 Markdown（标题、问题、选项 label + 说明），
**回复选项名即可继续** —— 与面板里的点击协议一致（面板点选项也是把 label 当消息发出去）。
把它渲染成可点的卡片需要注册 Chat 行（`conversation.chat.node`）与自定义事件类型，
而 practices 明确「不要用新的 session event 类型」，所以这一步留到以后再说。

### ADP 报文 → DSH 会话展示的字段映射

| ADP 报文 | DSH 会话展示 |
| --- | --- |
| `Message.Type = thought` 的 `text.delta` | 折叠的「思考过程」（`reasoning` 块） |
| `Message.Type = tool_call`（`ExtraInfo.ToolName` + `message.processing` 的 `Title`） | 思考过程里的一行 `🔧 工具：具体调用` |
| `Message.Type = reply` | 正文（`text` 块，Markdown） |
| `Content.Type = file` → `Content.File{FileName,FileUrl,FileSize,FileType}` | 复制到会话工作区 `adp-output/`，正文末尾「产出文件」列出**可点击预览的本地链接**（HTML/Office/PDF/代码在右侧栏打开），图片同时内联显示，附大小与类型、`原始下载` 链接 |
| 正文里指向该文件的 COS 链接（签名会变） | 按 origin + path 匹配，改写为工作区路径，点击即本地预览 |
| `Content.References[]`（`Name`/`DocName`/`DocRefer.Url`/`WebSearchRefer.Url`） | 「参考来源」编号链接列表 |
| `questionnaire` | 见上一节 |

文件元数据嵌套在 `Content.File` 里；早期实现读的是 `Content.FileName`/`Content.FileUrl`，
真实报文里这两个字段不存在，于是只剩一行无名、无链接的「📄 产出文件」。`fileInfoOf()`
按协议读取，旧的扁平写法保留为兜底。

复制文件的安全边界：只允许 HTTPS、默认端口、`fileDownloadHosts` 中的域名（不接受 IP 字面量与
URL 凭据）；**实际连接的解析地址**必须是公网地址（拒绝回环、私网、链路本地、组播、保留段及
9/10/11/21/30 段），不跟随重定向；单文件受 `fileDownloadMaxBytes` 限制，超时即中止并删除半成品；
文件名只取最后一段并清洗，目录经 realpath 校验不越出工作区，`wx` 独占创建、重名自动加后缀，
从不覆盖已有文件。复制失败时保留原始下载链接并注明原因。

### 开关与配置

| config | 默认 | 说明 |
| --- | --- | --- |
| `mentionEnabled` | `true` | `false` 时：两个 Host 监听不注册，`GET /mention-apps` 回 `bridge:false`，Client 的 `@` 分组随之消失（面板与工具不受影响） |
| `mentionPickTtlMs` | `1800000` | 选中后多久之内发送算数（选中即解析应用，所以要等打字） |
| `mentionIndexMs` | `60000` | 「已上架应用名 → appId」索引的复用时长 |
| `mentionReasoning` | `true` | 把 `thought` / `tool_call` 映射进折叠的思考过程；`false` 时只保留正文 |
| `fileDownload` | `true` | 把产出文件复制进会话工作区；`false` 时只列远程下载链接 |
| `fileDownloadDir` | `adp-output` | 工作区内的相对目录 |
| `fileDownloadHosts` | `["adp-cos.com","myqcloud.com"]` | 允许下载的 HTTPS 域名后缀 |
| `fileDownloadMaxBytes` | `52428800` | 单文件上限（50 MB），超出保留远程链接 |
| `fileDownloadTimeoutMs` | `60000` | 单文件下载超时 |
| `fileDownloadMaxFiles` | `10` | 单轮最多复制的文件数 |

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

> **改 Host 代码后如何不重启就生效。** DSH 的 Cordis Loader 用 `await import(name)` 加载插件，
> **没有 cache-busting**，模块 URL 一旦加载就在进程内永久缓存；`install_bundle` 也只会返回
> `restart-required`，`set_bundle` 关→开则只重跑 `apply`、拿到的仍是旧模块。
> 所以本插件的入口 `lib/entry.js` **不承载任何逻辑**，它每次被激活时都用**带 `?rev=<时间戳>` 的
> 动态 import** 加载真正的实现 `lib/impl.js`。
>
> 于是：**改完 `lib/impl.js`，`set_bundle` 关→开即可生效，不用重启、也不用改文件名** —— 已实测。
> （Node 的 ESM 按完整 URL 区分模块身份：查询串不同就会重新求值，相同则命中缓存。）

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
| `GET /adp-console/mention-apps` | `@` 菜单的候选：已上架（已上线）应用 + 出口行；无密钥时只回 `configured:false` |
| `POST /adp-console/bind` | 记下「这次选中的是哪个应用」`{sessionId, appId\|null, token}`，等携带它的那条消息 |
| `POST /adp-console/chat` | 会话，返回 `text/event-stream`（`console.delta` / `console.done` / `console.error` / `adp.event`；`console.done` 带 `transport`） |

路由只接受 loopback 的 `Host`，因此不接受浏览器跨站请求；密钥永不出现在页面里。

---

## 6. 自测

不需要腾讯云凭证，也不联网：本地起一个 mock ADP 网关，把真实 Host 代码整条链路跑一遍。

```bash
cd adp-console
node test/self-test.mjs      # 152 项断言
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
| 自测 179 项 | 通过 |
| TC3 签名 vs 官方文档向量 | 逐字节一致 |
| `capi.adp.tencent.com` 连通性 | **已实测**：请求被接受并返回独立站自己的业务错误格式 `450203-ErrSecretNotFound` |
| `adp.tencent.com/adp/v2/chat` 对话端点 | **已实测**：`200 text/event-stream`，返回标准 `error` 事件 |
| 腾讯云站 / 国际站连通性 | **已实测**：返回 `AuthFailure.SecretIdNotFound` |
| 线上实例已切到独立站 | **已确认**：`endpoint=capi.adp.tencent.com`、`chatEndpoint=https://adp.tencent.com/adp/v2/chat`、`wsEndpoint=wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/` |
| 线上路由 `/adp-console/*` | **已实测 200**（冷启动竞态修复后） |
| 线上工具注册（5 个） | 已确认 |
| 线上路由 `/config` `/apps` `/enabled` `POST /config` | 已确认 |
| 线上客户端面板两个 slot（`sidebar.panellist` + `main`） | 已确认注册且 active |
| 面板实际渲染 | **未验证**：读不到浏览器控制台，需你刷新页面点开面板确认 |
| `@` 菜单（Client）实际渲染 | **未验证**：同上。自测直接求值线上 `client.js` 的模块工厂并驱动真实 source（候选、筛选、选中、codec、`/bind`） |
| `@` 桥接（Host） | **离线实测通过**：自测驱动真实 `agent/pre-step` 与 `llm/stream` waterfall，拿到 mock 回复、表单渲染、粘性续聊、`@DSH` 退出、下架拦截等 30 项断言 |
| `@` 桥接（真实 ADP 应用 + 真实浏览器） | **未验证**：需要你在页面上真发一条 `@应用名` 的消息 |
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

### 页面布局：对话是主体，过程被弱化

三处调整：

**① 左栏收窄。** 原来网格是 `minmax(0,1fr) minmax(320px,420px)` —— 列表占 `1fr` 撑满、
对话被压到 320–420px，正好搞反了。现在列表是固定窄列、对话占满剩余：

```css
.adp-body{grid-template-columns:minmax(260px,320px) minmax(0,1fr)}
```

列表只是**选择器**，所以每行不再重复开关已经表达的状态（去掉了与 switch 冗余的
「已上架/已下架」标签），名称在窄列里也能读全。

**② 核心信息集中到右栏头部。** 应用名 + ADP 状态 + 能否被 DSH 调用 + 模式 + 会话号，
一眼看全；底部只留传输方式与可调用状态。

**③ 过程结果弱化**（对齐 DSH 的层次）：

| 元素 | 处理 |
| --- | --- |
| 思考行 | `label-tertiary`、22px 行高、状态点 5px |
| 工具行 | `label-secondary`（不再是 `label-primary`） |
| 正文 | 正常字号 + `label-primary`，与过程行之间留白 |
| 工具调用 | `TaskCreate({"activeForm":"调研 AI Agent 定义",…})` → **调研 AI Agent 定义** |

最后一条很重要：ADP 的工具 `Title` 是**原始调用**，直接显示等于把有用信息埋进标点里。
现在解析参数并挑出最有描述性的字段（`query` / `activeForm` / `description` / `command` …），
解析失败就退化成可读文本，并截断到 90 字符。

### 按 ADP 协议解析整个回合，实时展示

一个回合**不是一条消息**。抓到的真实生命周期：

```
  683ms  request_ack
 1056ms  response.created
 6231ms  ADD  Type=thought   Name=思考            ← 思考
 7263ms  ADD  Type=reply     Name=reply           ← 回复
 7450ms  ADD  Type=tool_call Name=执行命令 Tool=bash
 7591ms  PROC               Title="ls -la /workdir" ← 运行中才有具体命令
 8119ms  REPL               len=150                 ← 工具输出
 8120ms  DONE               Status=success
10121ms  ADD  Type=thought   …（下一步）
```

原来的 reducer 只认 `reply`，`thought` 直接丢弃、`tool_call` 只进事件列表 —— 于是面板在
Agent 干活的那几秒里**只有一个「…」**。实测：改之前首条可见文本在 **+6536ms**，
而 `adp.event` 从 +695ms 就一直在发。

现在按协议把每条消息变成时间线上的一条 entry（`reasoning` / `answer` / `tool` / `task`），
边收边推：

| 协议帧 | 时间线动作 |
| --- | --- |
| `message.added` | 新建 entry（按 `Message.Type` 定 kind，取 `ExtraInfo.ToolName`） |
| `message.processing` | 补上**具体调用**（`Title` = 命令行/文件名），状态 running |
| `content.added` | `file` 类型挂到该 entry 上（工具产出的文件） |
| `text.delta` / `text.replace` | 追加 / 替换该 entry 的文本（工具输出走 replace） |
| `message.done` | 置为 done |
| `response.completed` | **权威重建**整条时间线 |

两个实现要点：

- **入口用结构化补丁而非整段文本**：`console.entry` 只发变化（`append` / `text` / `status`），
  面板按 `MessageId` 合并。思考文本可能几万字符，所以只在 4000 字符内流式发送
  （面板本来就是折叠显示）。
- **权威重建不丢实时信息**：`response.completed` 会重述所有消息，但「具体调用命令」
  只存在于 `message.processing`、工具输出只存在于 `text.replace`，重建时必须与增量结果
  合并保留。另外 `json_text` 只在 `tool_call` 消息里算工具输出，在 `reply` 里是内部
  噪声、不能混进正文。

界面按 DSH 桌面端的 transcript 组织：**思考**折叠行（24px、13px、`label-tertiary`，
运行时状态点脉冲）、**工具**行（状态点 + 工具名 + 具体调用，可展开看输出与产出文件）、
然后是**正文** Markdown。

实测（真实应用）：

```
改前：首条可见文本 +6536ms
改后：首个 entry +4113ms（思考），随后 tool 行 +4463ms → title 补全 +4670ms
      一次回合内 reasoning 6 · answer 65 · tool 9 条 entry 补丁
```

### 对话内容按 DSH 的方式渲染

原来助手回复是 `white-space: pre-wrap` 的纯文本，于是 `**文件路径**：[…](https://…)`
这类 Markdown 标记**原样显示**。现在按宿主自己的渲染方式处理：

**版式对齐宿主 transcript**（`MessageItem.module.css` / `AssistantMarkdown.module.css`）
- 用户消息 → 右对齐气泡，`--dsw-specific-bubble` + `--dsw-radius-xl` + `10px 16px` 内边距
- 助手回复 → **全宽正文，不再套气泡**（宿主就是这样：助手回答不是气泡）
- 系统提示 → 居中、错误色

**Markdown 渲染**（`MarkdownText.module.css` 的 token 逐个照搬）
- 块级：标题、围栏代码、有序/无序列表（含嵌套）、引用、分隔线、管道表格、段落
- 行内：**加粗**、*斜体*、`行内代码`、[链接](url)、~~删除线~~
- 链接只允许 `http(s)`；`javascript:` 之类保持字面文本
- 标点与 CJK 相邻的加粗（`**中文**后面接中文`）也能正确闭合 —— 宿主为此专门写了
  `cjkFriendlyStrong` 扩展
- 单换行按 **CommonMark 软换行**处理（宿主没有启用 `breaks` 扩展，保持一致）

> 一个约束：工作区 Client half 只拿得到 `ctx / React / host / styles / console`
> （`listBuiltins` 实测），**拿不到宿主的 `MarkdownText`**，所以解析器是插件自带的。
> 样式只用主题 token，且对每个 token 都给了回退值。

用真实回复验证（1260 字符、17 段）：`**文件路径**` 与 `**摘要**` 变成 `<strong>`，
COS 链接变成 `<a>`（标签 `/workdir/agent_ppt_outline.md`），不再是字面标记。

### 多轮回复的分段

一个回合**不是一条消息**。Claw 智能体把每一步播报成各自的 `reply`
（「第一批资料已获取。」「继续搜索验证关键数据与产品信息。」…），而原来的
`extractFinalText` 只是把各条文本首尾相接：

```js
for (const message of messages) { for (const content of message.Contents) out += content.Text }
```

结果就是一整段连在一起的「墙」，句子之间连分隔都没有 —— 例如
「…挑战方面的**资料资料**已较充分」（两条消息的接缝）。

现在按消息分片：

- reducer 用 `Map<MessageId, text>` 保存每个 `reply` 的文本，最后用**空行**连接。
  `text.replace` 只替换**该条消息**的文本，不再清掉整段（原来 `delta = chunk` 会误伤）。
- 流式阶段同样带分隔：新消息的第一个 delta 会前置 `\n\n`，所以边流边看就是分好段的，
  不用等终态帧。
- 没有文本的消息（questionnaire、file）不产生空段落；单条 reply 不会被多加空行。

自测里 mock 增加了一个返回两条 reply 的分支，断言最终文本与流式增量都得到
`"第一批资料已获取。\n\n继续搜索验证关键数据。"`。

### 面板状态：切换功能再切回来不清空

切换主面板会**卸载**这个页面，所以状态放在 `useState` 里就会被丢掉 —— 现象是切走再切回来，
对话内容、ADP 会话 ID、甚至选中的智能体全没了（`current` 由 `selected` 推导，选中态一丢就
只剩空面板）。

现在三样东西都活在模块作用域（随 Web 会话存续，不落盘）：

| 状态 | 存放位置 |
| --- | --- |
| 消息、草稿、事件、ADP `ConversationId`、传输方式、`UserId`、进行中的 `AbortController` | 按 appId 分桶的 store，经 `useSyncExternalStore` 订阅 |
| 选中的智能体 | 模块变量 `lastSelectedAppId`，作为 `useState` 初值 |

要点：

- **卸载不再中断进行中的对话**：原来 `useEffect(() => () => abortRef.current?.abort(), [])`
  会在切走时掐断流；现在 controller 也在 store 里，切回来还能看到它继续跑完。
- **`UserId` 重挂载后保持不变**（原来每次 `useMemo` 重新随机），否则同一会话在服务端会被当成新访客。
- **换智能体不会误清**：store 按 appId 分桶，切回原来的应用仍是你原来的那段对话。
- 「新会话」是唯一的显式重置入口。

自测直接**求值线上 `client.js` 里的这段源码**（不是副本）来验证：remount 后数据仍在、
分桶互不干扰、退订生效、`UserId` 稳定。

### 人在回环组件（AskUserQuestion / questionnaire）

Claw 智能体要用户确认时会调用 **`AskUserQuestion`** 工具，平台把可作答的表单作为一条
**`Content.Type = "questionnaire"`** 的 reply 下发 —— 实测抓到的原文：

```json
{ "Type": "reply", "Contents": [{ "Type": "questionnaire", "Questionnaire": {
  "Title": "插图方式",
  "Questions": [{ "Index": 0, "Question": "PPT 中的插图希望采用哪种方式？", "Type": 1,
    "Options": [{ "Label": "AI 生成插图（推荐）", "Description": "…" }] }] } }] }
```

**这条 reply 完全没有文本**。原实现只抽取 `Type: 'text'` 的内容，于是整个问题被丢掉，
面板就停在上一句「需要确认插图方式：」——看起来像「展示不完整」，其实是组件没渲染。

现在：

- Host 侧 `extractInteractions()` 从权威的 `response.completed` / `message.done` 里抽取
  `questionnaire`（标题、问题、必填、多选、选项 label+description）与 `file`（产出文件），
  经 `console.done.interactions` 交给面板 —— 文本与组件**同时**返回，互不抢占。
- 面板渲染成卡片：选项是可点的按钮（label + 灰色描述）。**点击即把该选项的 label 作为下一条
  消息发出**——这是实测确认过的回答协议（Agent 收到 label 后继续干活，不会重新提问）。
  多选（`multiSelect`）时先选中再点「确认」。
- 事件列表也会显示工具调用的实际内容（`message.processing` 的 `Title`/`ToolName`），
  长任务不再是清一色的 `task.modify`。

### 会话超时：改成「按存活性」判定，而不是总时长

用户报的「websocket 超时」有两个来源，都已修掉：

**① 服务端主动断开时被静默忽略。** 实测握手被拒时服务端发的是
`42["error",{"Code":460001,"Message":"Token 校验失败"}]`，紧接 `41`（Socket.IO 断开）、
再以 `1006` 关闭。原实现忽略了 `41`，于是一路等到硬超时才报错。现在：

| 情况 | 现在的行为 |
| --- | --- |
| `41` / Engine.IO `1` / 未完成即关闭 | **立即** `ChatWsClosed`，不再等超时 |
| `44{...}`（握手被拒） | **立即** `ChatConnectError`，并带上服务端原文 |
| 长时间没有任何帧（含心跳） | `ChatStalled`，默认 **90s**（服务端每 25s ping，可容忍约 3 次丢包） |
| 单轮总时长 | `ChatTimeout`，默认 **15 分钟**（Claw 任务本来就慢，原来是 180s 硬上限） |

**② 原来用的是「总时长 180 秒」硬上限**，而 Claw 模式任务跑沙箱、动辄数分钟，很容易被误杀。
现在超时判据是**存活性**：任何一帧（包括心跳 `2`）都会重置计时器 —— 只要连接活着、
Agent 还在干活，就不会被判定超时。

两个值都可在 config 里调：`chatIdleTimeoutMs` / `chatTimeoutMs`；`adp_chat` 工具自身的
`timeoutMs` 也跟随 `chatTimeoutMs`。SSE 通道同样加了失活保护（超时即 abort，而不是无限等待），
失败时若已收到部分文本，会通过 `partialText` 带给面板，不会白丢。

自测里用**只完成 WebSocket 握手、随后保持沉默**的迷你服务端确定性地覆盖了这三种情形。

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

排障脚本：`node test/dump-events.mjs <appId> "消息" [会话ID]`（打印原始帧，用于确认内容类型）、`node test/chatprobe.mjs <appId>`、`node test/appkey.mjs <appId> [--chat] [--dump]`、
`node test/spaces.mjs`、`node test/chat.mjs <appId>`、`node test/live-chat.mjs <appId>`（后者驱动插件真实路由）。

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
| `lib/entry.js` | bundle 入口（稳定壳）：每次激活用带 `?rev=` 的动态 import 加载实现，使改动无需重启即可生效 |
| `lib/impl.js` | Host 半实现：官方 SDK / 内置 TC3 签名、ADP OpenAPI 客户端、上架开关、5 个工具、浏览器路由、SSE+WS 会话、超时治理、人在回环组件抽取，以及 `@` 桥接（`agent/pre-step` 绑定 + `llm/stream` 路由） |
| `client.js` | Client 半：侧边栏图标 + 主面板页面 + 流式会话 + `@` 引用源（`inputTriggers`，name=`adp`） |
| `locale/zh.json`、`locale/en.json` | 插件卡片的标题与描述 |
| `icon.svg` | 侧边栏与插件卡片图标 |
| `test/self-test.mjs` | 自测（不随 bundle 发布） |

**注意**：Host 半刻意不 import 任何 Harness 包。工作区 bundle 无法解析
`@deepseek-ai/*`（profile 的 `node_modules` 里只有你自己的包），所以本插件只用
Node 内置模块；配置默认值在 `lib/impl.js` 的 `DEFAULT_CONFIG` 里，运行期需要用户调整的
东西都放在面板的「设置」里。
