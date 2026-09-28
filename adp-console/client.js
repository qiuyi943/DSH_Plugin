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
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

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
      '.adp-msg{max-width:88%;padding:8px 10px;border-radius:10px;font-size:13px;',
      'word-break:break-word}',
      '.adp-msg.user{align-self:flex-end;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.adp-msg.agent{align-self:flex-start;background:var(--dsw-alias-bg-layer-2)}',
      '.adp-msgtext{white-space:pre-wrap}',
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

    function ChatPane(props) {
      const { app, t } = props;
      const [messages, setMessages] = useState([]);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [events, setEvents] = useState([]);
      const [conversationId, setConversationId] = useState('');
      const [transport, setTransport] = useState('');
      const abortRef = useRef(null);
      const scrollRef = useRef(null);
      const userId = useMemo(() => `dshweb${Math.random().toString(36).slice(2)}`, []);

      useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }, [messages]);

      const reset = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setMessages([]);
        setEvents([]);
        setConversationId('');
        setTransport('');
        setBusy(false);
      }, []);

      // A different app is a different conversation.
      useEffect(() => { reset(); }, [app && app.appId, reset]);
      useEffect(() => () => { abortRef.current?.abort(); }, []);

      const send = useCallback(async (override) => {
        const text = typeof override === 'string' ? override.trim() : draft.trim();
        if (text === '' || busy || !app) return;
        setDraft('');
        setBusy(true);
        setMessages(previous => [...previous, { role: 'user', text }, { role: 'agent', text: '' }]);
        const controller = new AbortController();
        abortRef.current = controller;
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
          abortRef.current = null;
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
                : messages.map((message, index) => h('div', {
                  key: index,
                  className: `adp-msg ${message.role === 'user' ? 'user' : message.role === 'sys' ? 'sys' : 'agent'}`,
                },
                h('div', { className: 'adp-msgtext' },
                  message.text === '' && busy && index === messages.length - 1 ? '…' : message.text),
                (message.interactions || []).map((interaction, position) => renderInteraction(
                  interaction, position, { busy, onChoose: label => void send(label) },
                )))),
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
                  onClick: () => abortRef.current?.abort(),
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
      const [selected, setSelected] = useState('');
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
