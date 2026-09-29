/**
 * ADP Console — Client half.
 *
 * The **ADP 智能体应用** entry in the global panel list and the page it opens:
 * the published ADP app catalogue, the 上架/下架 (enable/disable) gate that decides
 * whether DSH may call each app, and a streaming chat pane backed by the ADP
 * conversation API through the Host half's same-origin route.
 *
 * The browser half cannot sign Tencent Cloud requests (no secret may reach the page),
 * so every ADP call goes through `/adp-console/...`, registered by `index.js`.
 */

window.__ModuleLoader__.load({
  id: '@local/adp-console',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    /** Locale namespace and the id shared by the sidebar entry and the main panel. */
    const NS = 'adpConsole';
    const PANEL_ID = 'adp';
    /** Must equal the Host plugin's `routePrefix` config. */
    const ROUTE = '/adp-console';

    const zh = {
      panel: 'ADP 智能体',
      title: 'ADP 智能体应用',
      subtitle: '查看腾讯云 ADP 平台上已发布的智能体应用，控制哪些应用可以被 DSH 调用。',
      refresh: '刷新',
      search: '搜索应用名称',
      statusAll: '全部状态',
      statusRunning: '已上线',
      statusOffline: '未上线',
      statusDisabled: '已停用',
      onlyEnabled: '只看已上架',
      loading: '加载中…',
      empty: '没有匹配的应用。',
      error: '出错了',
      retry: '重试',
      unconfiguredTitle: '还没有配置腾讯云 API 密钥',
      unconfiguredBody:
        '插件需要一对腾讯云 API 密钥才能读取 ADP 应用清单。密钥只保存在本机的插件状态文件里（权限 0600），'
        + '不会发回浏览器。也可以在插件配置里填写 secretId / secretKey，或设置环境变量 '
        + 'TENCENTCLOUD_SECRET_ID 与 TENCENTCLOUD_SECRET_KEY。',
      settings: '设置',
      settingsClose: '收起',
      settingsTitle: '腾讯云 API 密钥',
      secretId: 'SecretId',
      secretKey: 'SecretKey',
      region: '地域',
      spaceId: '空间 ID',
      save: '保存',
      saving: '保存中…',
      clearCredentials: '清除密钥',
      sourcePanel: '来自此面板保存的密钥',
      sourceConfig: '来自插件配置',
      sourceEnv: '来自环境变量',
      sourceNone: '尚未配置',
      source: '来源',
      bothRequired: 'SecretId 与 SecretKey 必须同时填写。',
      site: '站点',
      siteCn: '中国站（腾讯云）',
      siteIntl: '国际站',
      siteStandalone: '独立站',
      siteHint: '密钥只属于一个站：腾讯云站用 CAM 密钥，独立站用 ADP 控制台「密钥管理」里的密钥。选错站点会报 SecretIdNotFound。',
      keySourceHint: '当前站点的密钥来源：',
      sdkOn: '管理接口：官方 ADP SDK',
      sdkFallback: '管理接口：内置 TC3 签名（未装 SDK）',
      sdkOff: '管理接口：内置 TC3 签名（已禁用 SDK）',
      spacesHint: '接口要的是 SpaceId（形如 bfnUUoSh），不是空间名字；下面列的是这把密钥能看到的真实空间。',
      spacesFailed: '暂时列不出空间：',
      spacesUnloaded: '填好密钥并保存后会列出可选空间；也可先用 adp_list_spaces 工具查询。',
      verify: '检测凭证',
      verifying: '检测中…',
      verdictOk: '密钥可用，ADP 接口正常。',
      verdictBadKey: '这组密钥在腾讯云侧不存在：连身份核对接口都拒绝它，所以与 ADP 无关。请按下面指出的来源重新获取密钥（独立站是 ADP 控制台「密钥管理」，腾讯云站是 CAM 控制台）。',
      verdictWrongSite: '密钥有效，但属于另一个站点。请把上面的「站点」切过去再检测。',
      verdictAdpPermission: '密钥有效，但当前站点的 ADP 接口被拒。请确认账号已开通 ADP、已加入该空间，且密钥有相应权限。',
      verdictForSite: '当前站点：',
      checkOk: '通过',
      checkFail: '失败',
      gateOn: '已上架',
      gateOff: '已下架',
      enable: '上架',
      disable: '下架',
      publish: '发布到 ADP',
      publishing: '发布中…',
      publishHint: '该应用在 ADP 上还没有成功发布，会话接口不会返回 AppKey。',
      dshCallable: 'DSH 可调用',
      dshBlocked: 'DSH 不可调用',
      chat: '与智能体对话',
      chatPick: '从左侧选择一个已上架的智能体开始对话。',
      chatBlocked: '该应用已下架，DSH 不能调用它。先上架再开始对话。',
      chatPlaceholder: '输入消息，回车发送',
      send: '发送',
      sending: '回复中…',
      stop: '停止',
      newConversation: '新会话',
      conversation: '会话',
      events: 'ADP 事件',
      noEvents: '暂无事件',
      appId: '应用 ID',
      mode: '模式',
      human: '你',
      agent: '智能体',
      copyId: '复制 ID',
      copied: '已复制',
      total: '共 {n} 个应用',
      enabledCount: '已上架 {n} 个',
      mentionSection: 'ADP 智能体',
      mentionEmpty: '还没有已上架的 ADP 应用',
      mentionEmptyEnabled: '先到「ADP 智能体」面板把应用上架，再回到这里 @ 它。',
      mentionEmptyKey: '先到「ADP 智能体」面板填写腾讯云密钥。',
      mentionExitHint: '结束 ADP 会话，把这条会话交回 DSH 本体。',
    };

    const en = {
      panel: 'ADP Agents',
      title: 'ADP Agent Apps',
      subtitle: 'Browse published Tencent Cloud ADP agent apps and control which ones DSH may call.',
      refresh: 'Refresh',
      search: 'Search app name',
      statusAll: 'All statuses',
      statusRunning: 'Running',
      statusOffline: 'Offline',
      statusDisabled: 'Disabled',
      onlyEnabled: 'Enabled only',
      loading: 'Loading…',
      empty: 'No matching app.',
      error: 'Error',
      retry: 'Retry',
      unconfiguredTitle: 'No Tencent Cloud API credentials yet',
      unconfiguredBody:
        'This plugin needs a Tencent Cloud API key pair to read the ADP app catalogue. The key stays in this machine’s '
        + 'plugin state file (mode 0600) and is never sent back to the browser. You may also set secretId / secretKey in '
        + 'the plugin config, or export TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY.',
      settings: 'Settings',
      settingsClose: 'Hide',
      settingsTitle: 'Tencent Cloud API key',
      secretId: 'SecretId',
      secretKey: 'SecretKey',
      region: 'Region',
      spaceId: 'Space id',
      save: 'Save',
      saving: 'Saving…',
      clearCredentials: 'Clear keys',
      sourcePanel: 'Saved from this panel',
      sourceConfig: 'From the plugin config',
      sourceEnv: 'From the environment',
      sourceNone: 'Not configured',
      source: 'Source',
      bothRequired: 'SecretId and SecretKey must both be filled in.',
      site: 'Site',
      siteCn: 'China (Tencent Cloud)',
      siteIntl: 'International',
      siteStandalone: 'Standalone (独立站)',
      siteHint: 'A key belongs to exactly one site: the cloud site uses CAM keys, the standalone site uses keys from the ADP console’s key management. The wrong site reports SecretIdNotFound.',
      keySourceHint: 'Key source for this site: ',
      sdkOn: 'Management API: official ADP SDK',
      sdkFallback: 'Management API: built-in TC3 signer (SDK not installed)',
      sdkOff: 'Management API: built-in TC3 signer (SDK disabled)',
      spacesHint: 'The API needs the SpaceId (like bfnUUoSh), not the space name; these are the real spaces this key can see.',
      spacesFailed: 'Could not list spaces: ',
      spacesUnloaded: 'Save a working key to pick from real spaces; meanwhile the adp_list_spaces tool can list them.',
      verify: 'Test credentials',
      verifying: 'Testing…',
      verdictOk: 'The key works and the ADP endpoint answers.',
      verdictBadKey: 'Tencent Cloud does not know this key: even the identity check rejects it, so ADP is not involved. Re-copy the SecretId from Access Management → API Keys, or create a new pair.',
      verdictWrongSite: 'The key is valid but belongs to the other site. Switch the Site selector above and test again.',
      verdictAdpPermission: 'The key is valid but the ADP endpoint on this site refused it. Check that the account has ADP enabled, is in that space, and that the key is authorised.',
      verdictForSite: 'Current site: ',
      checkOk: 'pass',
      checkFail: 'fail',
      gateOn: 'Enabled',
      gateOff: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      publish: 'Publish to ADP',
      publishing: 'Publishing…',
      publishHint: 'This app has no successful release on ADP, so the conversation API returns no AppKey.',
      dshCallable: 'DSH may call',
      dshBlocked: 'DSH blocked',
      chat: 'Chat with the agent',
      chatPick: 'Pick an enabled agent on the left to start chatting.',
      chatBlocked: 'This app is disabled, so DSH may not call it. Enable it first.',
      chatPlaceholder: 'Type a message, Enter to send',
      send: 'Send',
      sending: 'Replying…',
      stop: 'Stop',
      newConversation: 'New conversation',
      conversation: 'Conversation',
      events: 'ADP events',
      noEvents: 'No event yet',
      appId: 'App id',
      mode: 'Mode',
      human: 'You',
      agent: 'Agent',
      copyId: 'Copy id',
      copied: 'Copied',
      total: '{n} apps',
      enabledCount: '{n} enabled',
      mentionSection: 'ADP agents',
      mentionEmpty: 'No ADP agent is enabled',
      mentionEmptyEnabled: 'Enable an app in the ADP 智能体 panel first, then @ it here.',
      mentionEmptyKey: 'Save a Tencent Cloud key pair in the ADP 智能体 panel first.',
      mentionExitHint: 'Leave the ADP conversation and hand this session back to DSH.',
    };

    const CSS = [
      '.adp-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
      'padding:20px 24px;gap:14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      "font-family:inherit;font-size:14px;line-height:1.5}",
      '.adp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:0 0 auto}',
      '.adp-title{margin:0;font-size:16px;font-weight:600}',
      '.adp-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.adp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}',
      '.adp-input,.adp-select{height:30px;padding:0 10px;box-sizing:border-box;font:inherit;font-size:13px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;outline:none}',
      '.adp-input:focus,.adp-select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.adp-input{width:220px}',
      '.adp-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.adp-btn{height:30px;padding:0 12px;box-sizing:border-box;font:inherit;font-size:13px;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px}',
      '.adp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.adp-btn:disabled{opacity:.5;cursor:default}',
      '.adp-btn.primary{color:var(--dsw-alias-label-primary-foreground);',
      'background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent}',
      '.adp-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,420px);gap:14px;',
      'flex:1 1 auto;min-height:0}',
      '@media (max-width:900px){.adp-body{grid-template-columns:minmax(0,1fr)}}',
      '.adp-card{display:flex;flex-direction:column;min-height:0;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}',
      '.adp-cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;font-weight:600;flex:0 0 auto}',
      '.adp-list{overflow-y:auto;min-height:0;flex:1 1 auto}',
      '.adp-row{display:flex;align-items:center;gap:12px;padding:10px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}',
      '.adp-row:last-child{border-bottom:none}',
      '.adp-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.adp-row.sel{background:var(--dsw-alias-bg-layer-2)}',
      '.adp-avatar{width:32px;height:32px;border-radius:8px;object-fit:cover;flex:0 0 auto;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.adp-main{min-width:0;flex:1 1 auto}',
      '.adp-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.adp-meta{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.adp-tags{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.adp-pill{padding:1px 7px;border-radius:999px;font-size:11px;white-space:nowrap;',
      'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.adp-pill.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.adp-pill.off{color:var(--dsw-alias-state-idle-primary);border-color:currentColor}',
      '.adp-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.adp-switch{position:relative;width:38px;height:22px;flex:0 0 auto;padding:0;cursor:pointer;',
      'border-radius:999px;border:0;background:var(--dsw-alias-border-l3);',
      'transition:background .15s ease}',
      '.adp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.adp-switch:disabled{opacity:.5;cursor:default}',
      '.adp-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:var(--dsw-alias-label-primary-foreground);transition:transform .15s ease}',
      '.adp-switch[aria-checked="true"] .adp-knob{transform:translateX(16px)}',
      '.adp-note{margin:0;padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.adp-error{margin:0;padding:10px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.adp-chat{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}',
      '.adp-msgs{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}',
      // Transcript layout mirrors the Host: user = right-aligned bubble, assistant =
      // full-width prose, system = centred notice.
      '.adp-msg{display:flex;max-width:100%;min-width:0;font-size:var(--dsh-content-font-size,13px)}',
      '.adp-msg.user{justify-content:flex-end}',
      '.adp-msg.agent{justify-content:flex-start}',
      '.adp-msg.sys{justify-content:center}',
      '.adp-msg.user .adp-bubble{max-width:min(82%,520px);padding:10px 16px;',
      'border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2));',
      'color:var(--dsw-alias-label-primary)}',
      '.adp-msg.agent .adp-bubble{width:100%;min-width:0}',
      '.adp-msg.sys .adp-bubble{font-size:12px;color:var(--dsw-alias-state-error-primary);text-align:center}',
      '.adp-msgtext{white-space:pre-wrap;word-break:break-word}',
      // Markdown rules mirroring the Host sheet (MarkdownText.module.css) token for token.
      '.adp-md{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);',
      'font:var(--dsw-font-markdown-base,13px/1.7 inherit)}',
      '.adp-md>*:first-child{margin-top:0}',
      '.adp-md>*:last-child{margin-bottom:0}',
      '.adp-md strong{font-weight:600}',
      '.adp-md h1{font-size:1.5em;margin:24px 0 12px}',
      '.adp-md h2{font-size:1.3em;margin:24px 0 12px}',
      '.adp-md h3{font-size:1.15em;margin:24px 0 12px}',
      '.adp-md h4,.adp-md h5,.adp-md h6{font-size:1em;font-weight:600;margin:12px 0}',
      '.adp-md p{margin:12px 0}',
      '.adp-md a{color:var(--dsw-alias-link,var(--dsw-alias-label-primary));font-weight:500;text-decoration:none}',
      '.adp-md a:hover{text-decoration:underline dotted var(--dsw-alias-link,currentColor);text-underline-offset:3px}',
      '.adp-md :where(ul,ol){margin:12px 0;padding-left:18px}',
      '.adp-md li:not(:first-child){margin-top:6px}',
      '.adp-md li::marker{color:var(--dsw-alias-label-secondary)}',
      '.adp-md hr{display:block;border:none;height:.5px;margin:24px 0;background:var(--dsw-alias-border-l2)}',
      '.adp-md blockquote{border-left:2px solid var(--dsw-alias-label-caption);margin:12px 0 0;padding-left:14px}',
      '.adp-md pre{margin:12px 0;padding:10px 12px;overflow:auto;border-radius:var(--dsw-radius-sm,8px);',
      'background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);',
      'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.875em}',
      '.adp-md pre code{background:none;border:0;padding:0}',
      '.adp-md :not(pre)>code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);',
      'font-size:.875em;background:var(--dsw-alias-markdown-inline-code);border:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-sm,8px);padding:0 5px}',
      '.adp-md-table{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}',
      '.adp-md-table table{border-collapse:collapse;width:max-content;max-width:100%}',
      '.adp-md-table th{text-align:start;padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l3);',
      'font-weight:600;max-width:min(30vw,320px)}',
      '.adp-md-table td{padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);',
      'max-width:min(30vw,320px)}',
      '.adp-md-table th:first-child,.adp-md-table td:first-child{padding-left:0}',
      '.adp-card{margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.adp-cardtitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '.adp-question{margin-bottom:6px}',
      '.adp-questiontext{font-size:13px;margin-bottom:6px}',
      '.adp-options{display:flex;flex-direction:column;gap:6px}',
      '.adp-option{display:flex;flex-direction:column;gap:2px;text-align:left;cursor:pointer;',
      'padding:7px 9px;border-radius:6px;font:inherit;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.adp-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.adp-option:disabled{opacity:.5;cursor:default}',
      '.adp-option.active{border-color:var(--dsw-alias-brand-primary)}',
      '.adp-optionlabel{font-size:13px}',
      '.adp-optiondesc{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.adp-optionconfirm{align-self:flex-start;margin-top:6px}',
      '.adp-filelink{font-size:11px;color:var(--dsw-alias-state-business-primary);word-break:break-all}',
      '.adp-msg.sys{align-self:center;font-size:12px;color:var(--dsw-alias-state-error-primary);background:none}',
      '.adp-compose{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);',
      'flex:0 0 auto;align-items:flex-end}',
      '.adp-textarea{flex:1 1 auto;min-height:34px;max-height:120px;resize:vertical;box-sizing:border-box;',
      'padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;outline:none}',
      '.adp-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.adp-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;',
      'border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;',
      'color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.adp-events{max-height:120px;overflow:auto;margin:0;padding:8px 12px;font-size:11px;',
      'color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}',
      '.adp-events div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.adp-empty{padding:24px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.adp-skel{height:52px;margin:0;border-bottom:1px solid var(--dsw-alias-border-l1);',
      'background:linear-gradient(90deg,transparent,var(--dsw-alias-bg-layer-2),transparent)}',
      '.adp-form{display:grid;grid-template-columns:110px minmax(0,1fr);align-items:center;gap:8px 12px;padding:12px}',
      '.adp-form label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.adp-select.wide{width:100%}',
      '.adp-report{padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.adp-report p{margin:0 0 6px}',
      '.adp-checkrow{display:flex;align-items:center;gap:8px;padding:3px 0}',
      '.adp-checklabel{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.adp-input.wide{width:100%}',
      '.adp-formfoot{display:flex;align-items:center;gap:8px;padding:10px 12px;',
      'border-top:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.adp-metatext{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;max-width:240px}',
    ].join('');

    /** Locale keys for the ADP `AppStatus` enum, so the UI follows the active locale. */
    const ADP_STATUS_KEY = { 1: 'statusOffline', 2: 'statusRunning', 3: 'statusDisabled' };

    /** Page context: the bound translate function. */
    const AdpContext = React.createContext({ t: key => key });

    /** One JSON call against the Host route. */
    async function api(path, options) {
      const response = await fetch(ROUTE + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`);
      }
      return payload;
    }

    /** Split an SSE buffer into complete frames, returning the incomplete tail. */
    function takeFrames(buffer) {
      const frames = [];
      let rest = buffer;
      for (;;) {
        const lf = rest.indexOf('\n\n');
        const crlf = rest.indexOf('\r\n\r\n');
        let at = -1;
        let width = 2;
        if (lf < 0 && crlf < 0) break;
        if (crlf >= 0 && (lf < 0 || crlf < lf)) {
          at = crlf;
          width = 4;
        } else {
          at = lf;
        }
        frames.push(rest.slice(0, at));
        rest = rest.slice(at + width);
      }
      return { frames, rest };
    }

    /** Decode one SSE frame into its event name and data payload. */
    function decodeFrame(raw) {
      let name = '';
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const data = dataLines.join('\n');
      if (data === '') return { name, data: null };
      try {
        return { name, data: JSON.parse(data) };
      } catch {
        return { name, data };
      }
    }

    /** The sidebar glyph: a two-row "app list" mark at the requested size. */
    function AdpIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 6.5, rx: 2 }),
        h('rect', { key: 'b', x: 3, y: 13.5, width: 18, height: 6.5, rx: 2 }),
        h('path', { key: 'c', d: 'M6.6 7.25h.01' }),
        h('path', { key: 'd', d: 'M6.6 16.75h.01' }),
      );
    }

    /** One catalogue row: identity, ADP status, and the DSH gate switch. */
    function AppRow(props) {
      const { app, selected, busy, onSelect, onToggle, onPublish, t } = props;
      const statusKey = app.adpStatus === 2 ? 'on' : app.adpStatus === 3 ? 'warn' : 'off';
      const statusKey2 = ADP_STATUS_KEY[app.adpStatus];
      const statusText = statusKey2 !== undefined
        ? t(statusKey2)
        : (app.adpStatusDescription || app.adpStatusLabel?.zh || '—');
      const unpublished = app.adpStatus !== 2;
      return h('div', {
        className: `adp-row${selected ? ' sel' : ''}`,
        onClick: () => onSelect(app.appId),
        role: 'button',
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') onSelect(app.appId);
        },
      },
        app.avatar
          ? h('img', { className: 'adp-avatar', src: app.avatar, alt: '', loading: 'lazy' })
          : h('div', { className: 'adp-avatar', 'aria-hidden': true }),
        h('div', { className: 'adp-main' },
          h('div', { className: 'adp-name', title: app.name }, app.name || '(未命名)'),
          h('div', { className: 'adp-meta' },
            `${app.appId}${app.appModeLabel ? ` · ${app.appModeLabel.zh}` : ''}`),
        ),
        h('div', { className: 'adp-tags' },
          h('span', { className: `adp-pill ${statusKey}` }, statusText),
          app.dshEnabled
            ? h('span', { className: 'adp-pill on' }, t('gateOn'))
            : h('span', { className: 'adp-pill off' }, t('gateOff')),
          unpublished
            ? h('button', {
              className: 'adp-btn',
              type: 'button',
              disabled: busy,
              title: t('publishHint'),
              onClick: (event) => {
                event.stopPropagation();
                onPublish(app.appId);
              },
            }, busy ? t('publishing') : t('publish'))
            : null,
          h('button', {
            className: 'adp-switch',
            type: 'button',
            role: 'switch',
            'aria-checked': app.dshEnabled ? 'true' : 'false',
            'aria-label': app.dshEnabled ? t('disable') : t('enable'),
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation();
              onToggle(app.appId, !app.dshEnabled);
            },
          }, h('span', { className: 'adp-knob' })),
        ),
      );
    }

    /** The right-hand conversation pane, streaming through the Host route. */
    /* ------------------------------------------------------------------ *
     * Markdown, mirroring the host's own assistant-message rendering
     * ------------------------------------------------------------------ */

    /**
     * Inline spans: code, links, strong, emphasis, strikethrough.
     *
     * The Host renders assistant prose through `MarkdownText` (micromark + GFM), but a
     * workspace Client half only receives `React`, so the same shapes are produced here
     * with the host's token names. `depth` guards pathological nesting.
     */
    function inlineNodes(text, keyPrefix, depth) {
      const nodes = [];
      const source = String(text);
      const pattern = /`([^`\n]+)`|\[([^\]\n]*)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_/g;
      let cursor = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
        const key = `${keyPrefix}-i${index++}`;
        if (match[1] !== undefined) {
          nodes.push(h('code', { key }, match[1]));
        } else if (match[2] !== undefined) {
          const href = match[3];
          // Only http(s) destinations become anchors; anything else stays literal text.
          nodes.push(/^https?:\/\//i.test(href)
            ? h('a', { key, href, target: '_blank', rel: 'noreferrer' }, match[2] || href)
            : match[0]);
        } else if (match[4] !== undefined || match[5] !== undefined) {
          const inner = match[4] !== undefined ? match[4] : match[5];
          nodes.push(h('strong', { key }, depth > 0 ? inlineNodes(inner, key, depth - 1) : inner));
        } else if (match[6] !== undefined) {
          nodes.push(h('del', { key }, depth > 0 ? inlineNodes(match[6], key, depth - 1) : match[6]));
        } else {
          const inner = match[7] !== undefined ? match[7] : match[8];
          nodes.push(h('em', { key }, depth > 0 ? inlineNodes(inner, key, depth - 1) : inner));
        }
        cursor = pattern.lastIndex;
      }
      if (cursor < source.length) nodes.push(source.slice(cursor));
      return nodes;
    }

    /** The shared inline scanner for a block's text. */
    const inline = (text, key) => inlineNodes(text, key, 2);

    /** Split a table row into trimmed cells, tolerating the outer pipes. */
    function tableCells(line) {
      return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    }

    const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

    /**
     * Block-level markdown: headings, fences, lists, quotes, rules, tables, paragraphs.
     *
     * Deliberately CommonMark-ish rather than chat-lenient: the host adds no `breaks`
     * extension, so a lone newline inside a paragraph stays a soft break.
     */
    function blockNodes(markdown, keyPrefix) {
      const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
      const out = [];
      let i = 0;
      let block = 0;
      const nextKey = () => `${keyPrefix}-b${block++}`;

      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') { i += 1; continue; }

        const fence = /^\s*(?:```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
        if (fence !== null) {
          const body = [];
          i += 1;
          while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
          i += 1;
          out.push(h('pre', { key: nextKey(), className: 'adp-md-pre' },
            h('code', null, body.join('\n'))));
          continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = Math.min(heading[1].length, 6);
          out.push(h(`h${level}`, { key: nextKey() }, inline(heading[2].replace(/\s+#+\s*$/, ''), nextKey())));
          i += 1;
          continue;
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          out.push(h('hr', { key: nextKey() }));
          i += 1;
          continue;
        }

        if (/^\s*>/.test(line)) {
          const quoted = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s*>\s?/, ''));
            i += 1;
          }
          out.push(h('blockquote', { key: nextKey() }, blockNodes(quoted.join('\n'), nextKey())));
          continue;
        }

        // A table is a header row followed by a divider row.
        if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
          const header = tableCells(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(tableCells(lines[i]));
            i += 1;
          }
          out.push(h('div', { key: nextKey(), className: 'adp-md-table' },
            h('table', null,
              h('thead', null, h('tr', null, header.map((cell, column) =>
                h('th', { key: `h${column}` }, inline(cell, `h${column}`))))),
              h('tbody', null, rows.map((row, rowIndex) =>
                h('tr', { key: `r${rowIndex}` }, row.map((cell, column) =>
                  h('td', { key: `c${column}` }, inline(cell, `c${column}`)))))))));
          continue;
        }

        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (item !== null) {
          const ordered = /\d/.test(item[2]);
          const indent = item[1].length;
          const entries = [];
          while (i < lines.length) {
            const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
            if (current === null) break;
            if (current[1].length < indent) break;
            if (current[1].length > indent) {
              // A deeper marker continues the previous item as a nested list.
              const nested = [];
              while (i < lines.length) {
                const deeper = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
                if (deeper === null || deeper[1].length <= indent) break;
                nested.push(lines[i].slice(indent + 1));
                i += 1;
              }
              if (entries.length > 0) entries[entries.length - 1].children = nested.join('\n');
              continue;
            }
            entries.push({ text: current[3] });
            i += 1;
          }
          const listKey = nextKey();
          out.push(h(ordered ? 'ol' : 'ul', { key: listKey }, entries.map((entry, position) =>
            h('li', { key: `${listKey}-l${position}` },
              inline(entry.text, `${listKey}-l${position}`),
              entry.children === undefined ? null : blockNodes(entry.children, `${listKey}-l${position}`)))));
          continue;
        }

        // Paragraph: consecutive plain lines, soft-broken exactly like the host.
        const paragraph = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== ''
          && !/^\s*(?:#{1,6}\s|>|(?:```|~~~)|(?:[-*+]|\d+[.)])\s)/.test(lines[i])) {
          paragraph.push(lines[i]);
          i += 1;
        }
        out.push(h('p', { key: nextKey() }, inline(paragraph.join('\n'), nextKey())));
      }
      return out;
    }

    /** Assistant prose, rendered the way the Host renders its own. */
    function Markdown(props) {
      const { text, className } = props;
      const nodes = React.useMemo(() => blockNodes(text, 'md'), [text]);
      return h('div', { className: className === undefined ? 'adp-md' : `adp-md ${className}` }, nodes);
    }

    /**
     * Render one structured interaction from an ADP turn.
     *
     * A Claw agent asks for input through `AskUserQuestion`, and the platform delivers
     * the answerable form as a `questionnaire` content that carries no text at all — so
     * without this the question is invisible. Choosing an option sends its label as the
     * next message, which is how the platform expects the answer.
     */
    function renderInteraction(interaction, key, { busy, onChoose }) {
      if (!interaction || typeof interaction !== 'object') return null;

      if (interaction.kind === 'file') {
        const parts = [h('div', { key: 'title', className: 'adp-cardtitle' },
          interaction.name || '产出文件')];
        if (interaction.url) {
          parts.push(h('a', {
            key: 'link', className: 'adp-filelink',
            href: interaction.url, target: '_blank', rel: 'noreferrer',
          }, interaction.url));
        }
        return h('div', { className: 'adp-card', key }, parts);
      }

      if (interaction.kind !== 'questionnaire') return null;
      const [picked, setPicked] = useState({});
      const questions = Array.isArray(interaction.questions) ? interaction.questions : [];

      const questionNodes = questions.map((question) => {
        const options = (Array.isArray(question.options) ? question.options : []).map(option => h('button', {
          key: option.label,
          type: 'button',
          className: `adp-option${picked[question.index] === option.label ? ' active' : ''}`,
          disabled: busy,
          onClick: () => {
            if (question.multiSelect) {
              setPicked(previous => ({ ...previous, [question.index]: option.label }));
              return;
            }
            onChoose(option.label);
          },
        },
        h('span', { className: 'adp-optionlabel' }, option.label),
        option.description ? h('span', { className: 'adp-optiondesc' }, option.description) : null));

        const parts = [
          h('div', { key: 'text', className: 'adp-questiontext' }, question.question),
          h('div', { key: 'options', className: 'adp-options' }, options),
        ];
        if (question.multiSelect) {
          parts.push(h('button', {
            key: 'confirm',
            type: 'button',
            className: 'adp-btn primary adp-optionconfirm',
            disabled: busy || !picked[question.index],
            onClick: () => onChoose(picked[question.index]),
          }, '确认'));
        }
        return h('div', { key: question.index, className: 'adp-question' }, parts);
      });

      const parts = [];
      if (interaction.title) {
        parts.push(h('div', { key: 'title', className: 'adp-cardtitle' }, interaction.title));
      }
      parts.push(...questionNodes);
      return h('div', { className: 'adp-card', key }, parts);
    }

    /**
     * Chat state that outlives the pane.
     *
     * Switching to another main panel unmounts this component, so state kept in
     * `useState` was discarded and the conversation appeared cleared. The state lives in
     * a module-level store keyed by app id instead: navigating away and back re-attaches
     * to the same conversation, and a turn that is still streaming keeps filling it.
     * The in-flight `AbortController` lives here too, so an unmount must not cancel it.
     */
    function createChatStore() {
      let state = {
        messages: [], draft: '', busy: false, events: [],
        conversationId: '', transport: '', controller: null,
        userId: `dshweb${Math.random().toString(36).slice(2)}`,
      };
      const listeners = new Set();
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        get() { return state; },
        patch(update) {
          state = typeof update === 'function' ? update(state) : { ...state, ...update };
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** One store per ADP app, so switching apps switches conversation. */
    const chatStores = new Map();
    function chatStore(appId) {
      const key = appId === undefined || appId === null ? '(none)' : String(appId);
      let store = chatStores.get(key);
      if (store === undefined) {
        store = createChatStore();
        chatStores.set(key, store);
      }
      return store;
    }

    function ChatPane(props) {
      const { app, t } = props;
      const store = chatStore(app && app.appId);
      const { messages, draft, busy, events, conversationId, transport, userId } =
        useSyncExternalStore(store.subscribe, store.get);

      // Thin wrappers keep the original call sites readable while the data lives outside
      // the component.
      const setMessages = useCallback(
        update => store.patch(state => ({
          ...state,
          messages: typeof update === 'function' ? update(state.messages) : update,
        })), [store]);
      const setEvents = useCallback(
        update => store.patch(state => ({
          ...state,
          events: typeof update === 'function' ? update(state.events) : update,
        })), [store]);
      const setDraft = useCallback(value => store.patch({ draft: value }), [store]);
      const setBusy = useCallback(value => store.patch({ busy: value }), [store]);
      const setConversationId = useCallback(value => store.patch({ conversationId: value }), [store]);
      const setTransport = useCallback(value => store.patch({ transport: value }), [store]);
      const scrollRef = useRef(null);

      useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }, [messages]);

      // Only the explicit "new conversation" button resets; a remount must not, because
      // the store already holds the live conversation for this app.
      const reset = useCallback(() => {
        const controller = store.get().controller;
        if (controller) controller.abort();
        store.patch({
          messages: [], events: [], conversationId: '', transport: '', busy: false,
          controller: null, draft: '',
        });
      }, [store]);

      const send = useCallback(async (override) => {
        const text = typeof override === 'string' ? override.trim() : draft.trim();
        if (text === '' || busy || !app) return;
        setDraft('');
        setBusy(true);
        setMessages(previous => [...previous, { role: 'user', text }, { role: 'agent', text: '' }]);
        const controller = new AbortController();
        store.patch({ controller });
        try {
          const response = await fetch(`${ROUTE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              appId: app.appId,
              message: text,
              conversationId: conversationId || undefined,
              userId,
            }),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = takeFrames(buffer);
            buffer = parsed.rest;
            for (const rawFrame of parsed.frames) {
              const frame = decodeFrame(rawFrame);
              if (frame.name === 'console.meta') {
                if (frame.data && frame.data.conversationId) setConversationId(frame.data.conversationId);
                continue;
              }
              if (frame.name === 'console.delta') {
                const delta = frame.data && frame.data.text ? frame.data.text : '';
                if (delta !== '') {
                  setMessages(previous => {
                    const next = previous.slice();
                    const last = next[next.length - 1];
                    next[next.length - 1] = { role: 'agent', text: last.text + delta };
                    return next;
                  });
                }
                continue;
              }
              if (frame.name === 'console.done') {
                const final = frame.data && typeof frame.data.text === 'string' ? frame.data.text : '';
                if (frame.data && typeof frame.data.transport === 'string') setTransport(frame.data.transport);
                // A human-in-the-loop turn can carry no text at all, only a form.
                const interactions = frame.data && Array.isArray(frame.data.interactions)
                  ? frame.data.interactions
                  : [];
                setMessages(previous => {
                  const next = previous.slice();
                  const last = next[next.length - 1];
                  next[next.length - 1] = {
                    role: 'agent',
                    text: final !== '' ? final : last.text,
                    interactions: interactions.length > 0 ? interactions : undefined,
                  };
                  return next;
                });
                continue;
              }
              if (frame.name === 'console.error') {
                const message = frame.data && frame.data.error ? frame.data.error : t('error');
                setMessages(previous => [...previous, { role: 'sys', text: message }]);
                continue;
              }
              if (frame.name === 'adp.event') {
                const name = frame.data && frame.data.name ? frame.data.name : '?';
                // Tool calls carry what the agent is actually doing; without it a long
                // turn shows a wall of identical event names.
                const message = frame.data && frame.data.payload && frame.data.payload.Message;
                const tool = message && message.Type === 'tool_call'
                  ? (message.Title || (message.ExtraInfo && message.ExtraInfo.ToolName) || '')
                  : '';
                const detail = tool !== '' ? `${name} · ${String(tool).slice(0, 80)}` : name;
                setEvents(previous => [...previous.slice(-40), detail]);
              }
            }
          }
        } catch (error) {
          if (error && error.name !== 'AbortError') {
            setMessages(previous => [...previous, { role: 'sys', text: String(error.message || error) }]);
          }
        } finally {
          store.patch({ controller: null });
          setBusy(false);
        }
      }, [app, busy, conversationId, draft, t, userId]);

      if (!app) {
        return h('section', { className: 'adp-card' },
          h('div', { className: 'adp-cardhead' }, t('chat')),
          h('div', { className: 'adp-empty' }, t('chatPick')),
        );
      }

      const blocked = !app.dshEnabled;
      return h('section', { className: 'adp-card' },
        h('div', { className: 'adp-cardhead' },
          h('span', null, app.name || t('chat')),
          h('button', {
            className: 'adp-btn',
            type: 'button',
            onClick: reset,
            disabled: busy && messages.length === 0,
          }, t('newConversation')),
        ),
        blocked
          ? h('p', { className: 'adp-note' }, t('chatBlocked'))
          : h('div', { className: 'adp-chat' },
            h('div', { className: 'adp-msgs', ref: scrollRef },
              messages.length === 0
                ? h('div', { className: 'adp-empty' }, t('chatPick'))
                : messages.map((message, index) => {
                  const role = message.role === 'user' ? 'user' : message.role === 'sys' ? 'sys' : 'agent';
                  const pending = message.text === '' && busy && index === messages.length - 1;
                  const interactions = (message.interactions || []).map((interaction, position) =>
                    renderInteraction(interaction, position, { busy, onChoose: label => void send(label) }));
                  // Mirror the Host's transcript: the user turn is a right-aligned bubble
                  // while the assistant turn is full-width prose, not a second bubble.
                  return h('div', { key: index, className: `adp-msg ${role}` },
                    h('div', { className: 'adp-bubble' },
                      pending
                        ? h('div', { className: 'adp-md' }, '…')
                        : role === 'agent'
                          ? h(Markdown, { text: message.text })
                          : h('div', { className: 'adp-msgtext' }, message.text),
                      interactions));
                }),
            ),
            h('div', { className: 'adp-compose' },
              h('textarea', {
                className: 'adp-textarea',
                value: draft,
                placeholder: t('chatPlaceholder'),
                onChange: event => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                },
              }),
              busy
                ? h('button', {
                  className: 'adp-btn',
                  type: 'button',
                  onClick: () => store.get().controller?.abort(),
                }, t('stop'))
                : h('button', {
                  className: 'adp-btn primary',
                  type: 'button',
                  disabled: draft.trim() === '',
                  onClick: () => void send(),
                }, t('send')),
            ),
          ),
        events.length > 0
          ? h('div', { className: 'adp-events' },
            h('div', null, `${t('events')}: ${events.length}`),
            events.slice(-6).map((name, index) => h('div', { key: index }, `· ${name}`)),
          )
          : null,
        h('div', { className: 'adp-foot' },
          h('span', null, `${t('conversation')}: ${conversationId || '—'}${transport === '' ? '' : ` · ${transport.toUpperCase()}`}`),
          h('span', null, blocked ? t('dshBlocked') : t('dshCallable')),
        ),
      );
    }

    /** Credential and scope settings, persisted by the Host half. */
    function SettingsCard(props) {
      const { config, t, onSaved, onClose } = props;
      const [secretId, setSecretId] = useState('');
      const [secretKey, setSecretKey] = useState('');
      const [region, setRegion] = useState(config?.region || 'ap-guangzhou');
      const [spaceId, setSpaceId] = useState(config?.spaceId || 'default_space');
      const [site, setSite] = useState(config?.site || 'cn');
      const [spaces, setSpaces] = useState(null);
      const [spacesError, setSpacesError] = useState('');
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState('');
      const [report, setReport] = useState(null);

      useEffect(() => {
        setRegion(config?.region || 'ap-guangzhou');
        setSpaceId(config?.spaceId || 'default_space');
        setSite(config?.site || 'cn');
      }, [config]);

      // The API needs the SpaceId, not the space name (`default_space` is a name), so
      // offer the real ids whenever the current key can list them.
      const loadSpaces = useCallback(async () => {
        setSpacesError('');
        try {
          const result = await api('/spaces');
          setSpaces(Array.isArray(result.spaces) ? result.spaces : []);
        } catch (cause) {
          setSpaces([]);
          setSpacesError(String(cause.message || cause).split('\n')[0]);
        }
      }, []);

      useEffect(() => {
        if (config?.configured) void loadSpaces();
        else setSpaces(null);
      }, [config?.configured, loadSpaces]);

      /** Persist whatever the form currently holds, so a test uses the same values. */
      const persistForm = useCallback(async () => {
        if ((secretId.trim() === '') !== (secretKey.trim() === '')) {
          throw new Error(t('bothRequired'));
        }
        return api('/config', {
          method: 'POST',
          body: JSON.stringify({
            secretId: secretId.trim(),
            secretKey: secretKey.trim(),
            region: region.trim(),
            spaceId: spaceId.trim(),
            site,
          }),
        });
      }, [region, secretId, secretKey, site, spaceId, t]);

      const save = useCallback(async () => {
        setBusy(true);
        setFailure('');
        setReport(null);
        try {
          await persistForm();
          setSecretId('');
          setSecretKey('');
          await onSaved();
        } catch (cause) {
          setFailure(String(cause.message || cause));
        } finally {
          setBusy(false);
        }
      }, [onSaved, persistForm]);

      const verify = useCallback(async () => {
        setBusy(true);
        setFailure('');
        setReport(null);
        try {
          await persistForm();
          setSecretId('');
          setSecretKey('');
          const result = await api('/verify', { method: 'POST', body: JSON.stringify({}) });
          setReport(result);
        } catch (cause) {
          setFailure(String(cause.message || cause));
        } finally {
          setBusy(false);
        }
      }, [persistForm]);

      const VERDICT_KEY = {
        ok: 'verdictOk',
        'bad-key': 'verdictBadKey',
        'wrong-site': 'verdictWrongSite',
        'adp-permission': 'verdictAdpPermission',
      };

      const clear = useCallback(async () => {
        setBusy(true);
        setFailure('');
        try {
          await api('/config', { method: 'POST', body: JSON.stringify({ clear: true }) });
          await onSaved();
        } catch (cause) {
          setFailure(String(cause.message || cause));
        } finally {
          setBusy(false);
        }
      }, [onSaved]);

      const sourceLabel = {
        panel: t('sourcePanel'),
        config: t('sourceConfig'),
        env: t('sourceEnv'),
        none: t('sourceNone'),
      }[config?.source] || t('sourceNone');

      const field = (label, control) => [
        h('label', { key: `${label}-l` }, label),
        h(React.Fragment, { key: `${label}-c` }, control),
      ];

      return h('section', { className: 'adp-card' },
        h('div', { className: 'adp-cardhead' },
          h('span', null, t('settingsTitle')),
          onClose ? h('button', { className: 'adp-btn', type: 'button', onClick: onClose }, t('settingsClose')) : null,
        ),
        config?.configured === false ? h('p', { className: 'adp-note' }, t('unconfiguredBody')) : null,
        h('div', { className: 'adp-form' },
          field(t('secretId'), h('input', {
            className: 'adp-input wide',
            value: secretId,
            placeholder: config?.secretIdHint || 'AKID…',
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => setSecretId(event.target.value),
          })),
          field(t('secretKey'), h('input', {
            className: 'adp-input wide',
            type: 'password',
            value: secretKey,
            placeholder: config?.hasSecretKey ? '••••••••' : '',
            autoComplete: 'new-password',
            onChange: event => setSecretKey(event.target.value),
          })),
          field(t('region'), h('input', {
            className: 'adp-input wide',
            value: region,
            spellCheck: false,
            onChange: event => setRegion(event.target.value),
          })),
          field(t('spaceId'), spaces !== null && spaces.length > 0
            ? h('select', {
              className: 'adp-select wide',
              value: spaces.some(space => space.spaceId === spaceId) ? spaceId : spaces[0].spaceId,
              onChange: event => setSpaceId(event.target.value),
            }, spaces.map(space => h('option', {
              key: space.spaceId,
              value: space.spaceId,
            }, `${space.name || '(无名称)'} · ${space.spaceId}`)))
            : h('input', {
              className: 'adp-input wide',
              value: spaceId,
              spellCheck: false,
              onChange: event => setSpaceId(event.target.value),
            })),
          field('', h('span', { className: 'adp-metatext' },
            spacesError !== ''
              ? `${t('spacesFailed')}${spacesError}`
              : spaces !== null && spaces.length > 0
                ? t('spacesHint')
                : t('spacesUnloaded'))),
          field(t('site'), h('select', {
            className: 'adp-select wide',
            value: site,
            onChange: event => setSite(event.target.value),
          },
            h('option', { value: 'cn' }, t('siteCn')),
            h('option', { value: 'intl' }, t('siteIntl')),
            h('option', { value: 'standalone' }, t('siteStandalone')),
          )),
          field('', h('span', { className: 'adp-metatext', title: t('siteHint') },
            `${t('siteHint')}${config?.keySource ? ` ${t('keySourceHint')}${config.keySource}` : ''}`)),
        ),
        failure !== '' ? h('p', { className: 'adp-error' }, failure) : null,
        report !== null
          ? h('div', { className: 'adp-report' },
            h('p', {
              className: report.verdict === 'ok' ? 'adp-note' : 'adp-error',
            }, `${t(VERDICT_KEY[report.verdict] || 'verdictBadKey')}\n`
              + `${t('verdictForSite')}${t({ cn: 'siteCn', intl: 'siteIntl', standalone: 'siteStandalone' }[report.site] || 'siteCn')}`
              + `${config?.keySource ? ` · ${t('keySourceHint')}${config.keySource}` : ''}`),
            (report.checks || []).map(check => h('div', { key: check.id, className: 'adp-checkrow' },
              h('span', { className: `adp-pill ${check.ok ? 'on' : 'warn'}` }, check.ok ? t('checkOk') : t('checkFail')),
              h('span', { className: 'adp-checklabel' }, `${check.label} · ${check.endpoint}`),
              h('span', { className: 'adp-metatext', title: check.message }, check.message),
            )),
          )
          : null,
        h('div', { className: 'adp-formfoot' },
          h('span', { className: 'adp-pill' }, `${t('source')}: ${sourceLabel}`),
          h('span', { className: 'adp-metatext' },
            config?.sdk?.transport === 'sdk' ? t('sdkOn') : config?.sdk?.enabled === false ? t('sdkOff') : t('sdkFallback')),
          h('span', { className: 'adp-metatext', title: config?.statePath || '' }, config?.statePath || ''),
          h('span', { style: { flex: '1 1 auto' } }),
          config?.configured
            ? h('button', { className: 'adp-btn', type: 'button', disabled: busy, onClick: clear }, t('clearCredentials'))
            : null,
          h('button', {
            className: 'adp-btn',
            type: 'button',
            disabled: busy,
            onClick: verify,
          }, busy ? t('verifying') : t('verify')),
          h('button', {
            className: 'adp-btn primary',
            type: 'button',
            disabled: busy,
            onClick: save,
          }, busy ? t('saving') : t('save')),
        ),
      );
    }

    /** The panel page: catalogue on the left, conversation on the right. */
    /**
     * The app chosen in the pane, kept outside the component so returning to this panel
     * restores the same conversation instead of an empty one.
     */
    let lastSelectedAppId = '';

    /* ------------------------------------------------------------------ *
     * `@` mention source
     * ------------------------------------------------------------------ */

    /**
     * The source name the composer records on every chip it inserts. The submit path
     * asks the registered source for `codec.serialize`, so this is what turns a chip
     * into the `@name` the Host binds the session from.
     */
    const MENTION_SOURCE = 'adp';

    /**
     * The source's dictionary, bound when the plugin applies. The menu is built
     * outside the panel's React context, so it cannot read `AdpContext`.
     */
    let mentionText = key => key;

    /**
     * The `@` targets of the current gate: enabled apps, a terminating exit row, and
     * the copy the empty states need. Fetched lazily and shared by every session in the
     * page, because the gate is process-wide.
     */
    let mentionTargets = null;
    let mentionFetch = null;

    /** The gate (or the credentials) changed: the next menu reflects it. */
    function invalidateMentions() {
      mentionTargets = null;
      mentionFetch = null;
    }

    /** One `GET /mention-apps`, shared by concurrent keystrokes. */
    function loadMentionTargets() {
      if (mentionTargets !== null) return Promise.resolve(mentionTargets);
      if (mentionFetch === null) {
        mentionFetch = api('/mention-apps')
          .then((payload) => {
            mentionTargets = {
              apps: Array.isArray(payload.apps) ? payload.apps : [],
              configured: payload.configured === true,
              bridge: payload.bridge !== false,
              exit: payload.exit && typeof payload.exit === 'object' ? payload.exit : { token: 'DSH', label: 'DSH' },
            };
            return mentionTargets;
          })
          .finally(() => { mentionFetch = null; });
      }
      return mentionFetch;
    }

    /** The pick payload one menu row carries. */
    function mentionValue(value) {
      try { return JSON.parse(value || ''); } catch { return null; }
    }

    /** The name a chip shows and the Host resolves: one whitespace-free word. */
    function mentionName(app) {
      return String(app.token || app.name || app.appId || '').trim();
    }

    /**
     * The menu's secondary line: app mode plus ADP status. ADP sends both labels as
     * `{zh, en}` dictionaries (the panel reads `.zh`); the status has its own locale
     * key, so the status half follows the active locale.
     */
    function mentionDescription(app, t) {
      const mode = app.appModeLabel?.zh || '';
      const statusKey = ADP_STATUS_KEY[app.adpStatus];
      const status = statusKey === undefined ? (app.adpStatusLabel?.zh || '') : t(statusKey);
      return [mode, status].filter(Boolean).join(' · ') || undefined;
    }

    const adpMentionSource = {
      trigger: '@',
      name: MENTION_SOURCE,
      order: 5,
      showGroupTitle: false,
      async candidates(session, { query, signal }) {
        const targets = await loadMentionTargets();
        // The Host half can be switched off (`mentionEnabled: false`); then this group
        // contributes nothing at all rather than inserting mentions nothing resolves.
        if (targets.bridge === false) return [];
        // A superseded keystroke reads the warm cache next time; never race it.
        if (signal.aborted) return [];
        const t = mentionText;
        const needle = String(query || '').toLowerCase();
        const rows = targets.apps
          .filter(app => needle === ''
            || String(app.name || '').toLowerCase().includes(needle)
            || String(app.appId || '').includes(needle))
          .map(app => ({
            name: app.name || app.appId,
            description: mentionDescription(app, t),
            icon: 'session',
            section: t('mentionSection'),
            value: JSON.stringify({ kind: 'app', appId: app.appId, token: mentionName(app), label: app.name || app.appId }),
          }));
        rows.push({
          name: targets.exit.label || 'DSH',
          description: t('mentionExitHint'),
          icon: 'session',
          section: t('mentionSection'),
          value: JSON.stringify({ kind: 'exit', token: targets.exit.token || 'DSH' }),
        });
        if (targets.apps.length === 0) {
          rows.unshift({
            name: t('mentionEmpty'),
            description: targets.configured ? t('mentionEmptyEnabled') : t('mentionEmptyKey'),
            section: t('mentionSection'),
            value: JSON.stringify({ kind: 'hint' }),
          });
        }
        return rows;
      },
      warm() {
        // Fill the menu before the first `@` without blocking anything.
        void loadMentionTargets().catch(() => {});
      },
      onPick({ candidate, session }) {
        const value = mentionValue(candidate.value);
        if (value === null || value.kind === 'hint') return 'handled';
        const appId = value.kind === 'exit' ? null : String(value.appId || '');
        const token = String(value.token || '').replace(/^@/, '');
        if (token === '') return 'handled';
        // The prompt carries only the readable `@name`; the id has to reach the Host
        // before the message does, or the Host would have to guess an app from a label.
        void api('/bind', {
          method: 'POST',
          body: JSON.stringify({ sessionId: session.sessionId, appId, token }),
        }).catch(() => {});
        return {
          insert: {
            source: MENTION_SOURCE,
            // Self-contained: the codec only ever receives this string back.
            ref: JSON.stringify({ appId, token }),
            label: value.label || token,
            appearance: 'session',
            clipboardText: `@${token}`,
          },
        };
      },
      /**
       * A chip's `ref` is opaque to the pipeline and this is the only thing the codec
       * receives, so the ref is the pick payload itself: what the model reads is the
       * `@name`, and what the clipboard keeps is the same mention in plain text.
       */
      codec: {
        clipboardText(ref) {
          const value = mentionValue(ref);
          return value === null ? ref : `@${value.token}`;
        },
        serialize(ref) {
          const value = mentionValue(ref);
          return Promise.resolve(value === null ? ref : `@${value.token}`);
        },
      },
    };

    /**
     * Register the source once the input pipeline exists. `ctx.inject` parks the
     * registration until the service is there (a cold page can apply this plugin before
     * the composer does); the direct lookup covers a context without that helper.
     */
    function registerMentionSource(ctx) {
      const register = triggerCtx => triggerCtx.effect(
        () => triggerCtx.inputTriggers.registerSource(adpMentionSource),
        'adp-console: @ source',
      );
      if (typeof ctx.inject === 'function') {
        ctx.inject(['inputTriggers'], register);
        return;
      }
      const inputTriggers = ctx.get('inputTriggers');
      if (inputTriggers === undefined) {
        console.error('[adp-console] inputTriggers 不可用，@ 菜单入口未注册。');
        return;
      }
      ctx.effect(() => inputTriggers.registerSource(adpMentionSource), 'adp-console: @ source');
    }

    function AdpPage() {
      const ctx = React.useContext(AdpContext);
      const t = ctx.t;
      const [config, setConfig] = useState(null);
      const [apps, setApps] = useState([]);
      const [total, setTotal] = useState(0);
      const [query, setQuery] = useState('');
      const [status, setStatus] = useState('running');
      const [onlyEnabled, setOnlyEnabled] = useState(false);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [selected, setSelectedState] = useState(() => lastSelectedAppId);
      const setSelected = useCallback((appId) => {
        lastSelectedAppId = appId;
        setSelectedState(appId);
      }, []);
      const [busyId, setBusyId] = useState('');
      const [showSettings, setShowSettings] = useState(false);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          // Config first: without credentials the catalogue call would only add noise to
          // the error line, and the page shows its setup card instead.
          const configResult = await api('/config');
          setConfig(configResult);
          if (configResult.configured === false) {
            setApps([]);
            setTotal(0);
            return;
          }
          const params = new URLSearchParams({ status, pageSize: '100' });
          if (query.trim() !== '') params.set('query', query.trim());
          const listResult = await api(`/apps?${params.toString()}`);
          setApps(Array.isArray(listResult.apps) ? listResult.apps : []);
          setTotal(typeof listResult.total === 'number' ? listResult.total : 0);
        } catch (cause) {
          setError(String(cause.message || cause));
        } finally {
          setLoading(false);
        }
      }, [query, status]);

      useEffect(() => { void load(); }, [load]);

      const toggle = useCallback(async (appId, enabled) => {
        setBusyId(appId);
        try {
          await api('/enabled', { method: 'POST', body: JSON.stringify({ appId, enabled }) });
          setApps(previous => previous.map(app => (app.appId === appId ? { ...app, dshEnabled: enabled } : app)));
          // 上架/下架 is exactly what the `@` menu lists.
          invalidateMentions();
        } catch (cause) {
          setError(String(cause.message || cause));
        } finally {
          setBusyId('');
        }
      }, []);

      const publish = useCallback(async (appId) => {
        setBusyId(appId);
        try {
          await api('/release', { method: 'POST', body: JSON.stringify({ appId }) });
          await load();
          invalidateMentions();
        } catch (cause) {
          setError(String(cause.message || cause));
        } finally {
          setBusyId('');
        }
      }, [load]);

      const visible = onlyEnabled ? apps.filter(app => app.dshEnabled) : apps;
      const enabledCount = apps.filter(app => app.dshEnabled).length;
      const current = apps.find(app => app.appId === selected) || null;

      const unconfigured = config !== null && config.configured === false;
      const settingsOpen = unconfigured || showSettings;

      return h('div', { className: 'adp-root' },
        h('style', null, CSS),
        h('header', { className: 'adp-head' },
          h('div', null,
            h('h1', { className: 'adp-title' }, t('title')),
            h('p', { className: 'adp-sub' }, t('subtitle')),
          ),
          h('div', { className: 'adp-bar' },
            h('span', { className: 'adp-pill' }, t('total').replace('{n}', String(total))),
            h('span', { className: 'adp-pill on' }, t('enabledCount').replace('{n}', String(enabledCount))),
            h('button', {
              className: 'adp-btn',
              type: 'button',
              onClick: () => setShowSettings(open => !open),
            }, t('settings')),
            h('button', { className: 'adp-btn', type: 'button', onClick: () => void load(), disabled: loading },
              t('refresh')),
          ),
        ),

        settingsOpen
          ? h(SettingsCard, {
            config,
            t,
            onSaved: async () => {
              setShowSettings(false);
              // New credentials mean a different catalogue behind the `@` menu too.
              invalidateMentions();
              await load();
            },
            onClose: unconfigured ? null : () => setShowSettings(false),
          })
          : null,

        unconfigured
          ? null
          : h(React.Fragment, null,
            h('div', { className: 'adp-bar' },
              h('input', {
                className: 'adp-input',
                value: query,
                placeholder: t('search'),
                onChange: event => setQuery(event.target.value),
              }),
              h('select', {
                className: 'adp-select',
                value: status,
                onChange: event => setStatus(event.target.value),
              },
                h('option', { value: 'running' }, t('statusRunning')),
                h('option', { value: 'offline' }, t('statusOffline')),
                h('option', { value: 'disabled' }, t('statusDisabled')),
                h('option', { value: 'all' }, t('statusAll')),
              ),
              h('label', { className: 'adp-check' },
                h('input', {
                  type: 'checkbox',
                  checked: onlyEnabled,
                  onChange: event => setOnlyEnabled(event.target.checked),
                }),
                t('onlyEnabled'),
              ),
            ),

            error !== ''
              ? h('p', { className: 'adp-error' }, `${t('error')}: ${error}`)
              : null,

            h('div', { className: 'adp-body' },
              h('section', { className: 'adp-card' },
                h('div', { className: 'adp-cardhead' }, h('span', null, t('title'))),
                h('div', { className: 'adp-list' },
                  loading && visible.length === 0
                    ? [0, 1, 2].map(index => h('div', { key: index, className: 'adp-skel' }))
                    : visible.length === 0
                      ? h('div', { className: 'adp-empty' }, t('empty'))
                      : visible.map(app => h(AppRow, {
                        key: app.appId,
                        app,
                        selected: app.appId === selected,
                        busy: busyId === app.appId,
                        onSelect: setSelected,
                        onToggle: toggle,
                        onPublish: publish,
                        t,
                      })),
                ),
              ),
              h(ChatPane, { app: current, t }),
            ),
          ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'adp-console: dictionaries');
        const t = ctx.locale.bind(NS);
        // The `@` menu is built outside the panel's React tree, so it needs its own binding.
        mentionText = t;
        registerMentionSource(ctx);
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, function AdpPanel() {
          return h(AdpContext.Provider, { value: { t } }, h(AdpPage));
        }));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel'),
        }, AdpIcon));
      },
    };
  },
});
