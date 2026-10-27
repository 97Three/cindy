## 4.23 随包浏览器扩展(browserExtension 能力)

插件随包携带一个 Chrome / Edge 扩展(翻译、字幕、页面读取之类"住在用户浏览器里"的功能)时,
由 **Cindy 承接扩展的连接**:配对、身份绑定、作业分发、站点策略守门、结果脱敏都在宿主,插件
不再自带接线进程。在身份卡声明:

```json
"browserExtension": {
  "protocol": "cindy-browser-extension/3",
  "extensionIds": ["dmbhhhdijpeaibfeocdcjhfefkgpkeef"],
  "nativeHost": { "name": "com.example.browser", "binary": "native-host/bin" },
  "pageControl": true
}
```

- `extensionIds` 是全部知情面:只有这些扩展能连上宿主桥接(商店版、Edge 版、开发版各一条),
  装入时逐条展示并钉死;新增 id 要发新版本并重新确认权限。
- `nativeHost` 可选:首次配对用的 Native Messaging host。宿主把 `<binary>/<platform>-<arch>/`
  下的二进制复制到本机私有目录并向各浏览器注册;二进制由你随包提供并签名。
- `pageControl: true` 表示扩展实现**页面控制契约**(tabs / navigate / snapshot / extract / act),
  用户在设置 →「自动操作」选「我的浏览器」后,Agent 的 `browser` 工具会经它操作用户正在用的
  浏览器。只做翻译/字幕通道的扩展不要声明它。

运行期两条管子:

```js
// 插件 → 宿主:向扩展投递作业、推送站点策略与配对身份、回传转交结果
const status = await cindy.send({ type: 'browser-extension-request', kind: 'status' });
if (!status.ok && status.errorCode) {
  // 旧宿主不认识这个槽:回落到你自己的接线进程,不要把拒绝当作已连接
}
await cindy.send({ type: 'browser-extension-request', kind: 'setPolicy', policy });
await cindy.send({ type: 'browser-extension-request', kind: 'setTrustedClients', clients: paired });
const result = await cindy.send({
  type: 'browser-extension-request',
  kind: 'act',
  action: 'extract',
  payload,
});

// 宿主 → 插件:扩展发起的请求(翻译、字幕…)转交给你处理
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event' || msg.name !== 'browser-extension-relay') return;
  const { id, clientId, request } = msg;
  await cindy.send({
    type: 'browser-extension-request',
    kind: 'relayProgress',
    id,
    progress: { stage: 'model' },
  });
  const result = await handle(
    clientId,
    request,
    async () =>
      (await cindy.send({ type: 'browser-extension-request', kind: 'relayActive', id })).active ===
      true,
  );
  await cindy.send({ type: 'browser-extension-request', kind: 'relayResult', id, result });
});
```

规则与红线:

- **站点策略归你**:读取默认开放公网、交互按站点授权、本机与私网一律拒绝。你保存并在启动
  与每次变更时 `setPolicy` 推给宿主;宿主缓存到用户私有目录并在每个作业上强制,新授权必须经
  `cindy.confirm` 真实确认。
- **作业一次送达**:已送达的作业不会重投;结果 `execution` 为 `unknown` 时要让 Agent 核对
  页面,不能当成功或未执行报告。
- **宿主代码不认识你**:桥接只按声明工作,不会为某个插件写特例;需要线协议之外的能力,先提
  Cindy 改动,不要在扩展里绕过。
- **向下兼容**:旧宿主没有这个槽,`status` 返回 `errorCode`;插件必须保留自带接线进程的降级
  路径(或明确提示升级 Cindy),不能让已装用户的功能消失。
