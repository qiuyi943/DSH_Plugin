# DSH Plugins

DeepSeek Harness（DSH）插件集合。每个子目录是一个可独立安装的 bundle。

## 插件列表

| 目录 | 说明 |
| --- | --- |
| [`adp-console/`](./adp-console) | 腾讯云 ADP 智能体应用控制台：查看已发布应用清单、上架/下架（DSH 调用开关）、与已上架应用对话（SSE 优先，自动回退 WebSocket）。详见该目录的 [README](./adp-console/README.md)。 |

## 安装

插件通过 `plugin_manager` 以 bundle 形式安装，`target` 指向**包目录**：

```
plugin_manager install_bundle  target: <本仓库>/adp-console
```

首次安装按目录路径即可；**该依赖已存在后再安装要写包名**（写路径会报 `ambiguous-install`）：

```
plugin_manager install_bundle  target: @local/adp-console
```

### 更新已安装的插件

`install_bundle` 对已安装的包会返回 `restart-required`。用 bundle 的关→开可以强制重新组装：

```
plugin_manager set_bundle  enabled: false  target: <包名>
plugin_manager set_bundle  enabled: true   target: <包名>
```

注意：关→开会重跑插件代码的 `apply`，但**不一定重新 import 模块**；Host 侧逻辑改动若不生效，需要重启 DSH。

## 约定

- 工作区 bundle **不 import 任何 `@deepseek-ai/*` 包**：工作区包解析不到 dsh 安装目录，
  所以插件只用 Node 内置模块。需要用户可调的值放进面板「设置」或 `cordis.patch.yml`。
- 浏览器侧路由必须用 `ctx.inject(['webServer'], …)` 注册，不要用一次性
  `ctx.get('webServer')` —— 冷启动时 HTTP 载体尚未就绪，会静默丢掉路由。
- 面板样式只用主题 token，且**背景与前景必须成对**：
  `--dsw-alias-button-primary-fill` 配 `--dsw-alias-label-primary-foreground`，
  切勿在 `brand-primary` 上写死 `#fff`（该 token 在暗色主题会反转为近白）。
- 每个插件自带自测，不联网、不需要真实凭证即可跑：

```bash
cd adp-console && node test/self-test.mjs
```

## 许可

内部使用。
