# 插件伙伴委派：审核接线与真实验收

日期：2026-10-29。协议与回执阶段见 plugin-target-delegation-stage.md。

## 实现范围

新增 cindy-brain/pluginTargetReview.ts，读取当前已接受的 plugin-target 输入，对既有回执、独立委派批准、owner、活跃本机 canonical 伙伴、scope、消息来源及授权投影做复核，转换为现有 PluginReviewSnapshot。跨 await 重验 owner 与运行代次；最终 SQL 同时约束回执、消息、Session 与版本化投影。

register.ts 仅连接现有输入协调器只读 API、既有 Auto resolver 和就绪标记。没有修改 maker-core、输入协调器、伙伴身份、默认权限或审核模型路由。插件未设置 permission ceiling 时沿用伙伴真实权限；显式 Ask/Plan/上限不提升。

取消回执只有在持久撤回后，Host 核实队列和运行状态均已结束时才包含 settled、原 requestKey 和 clientId。旧取消响应保持兼容；未知状态及在途发送不冒报结束。

## 验证

- pluginTargetSlot 72 项、pluginTaskStorePagination 27 项、原 pluginTaskReviewContext 78 项通过。后两者复用真实 SQLite 及现有 Auto resolver，覆盖撤销、安装变化、其他插件/伙伴、owner/输入切换、共享访客、Ask、Plan、显式 ceiling、范围删除。
- Desktop typecheck 通过；test-hygiene 通过。第一阶段协议与兼容测试结论保留，不冒称重新全量执行。
- 独立 feishu-auth 客户端保持本地未登录，minimax 应用绑定未改；真实伙伴 cindy-default（Pi，mag47/group/plus）仍为 Auto。
- 内置审核 HTTP 429；主人明确允许本次 mag47 辅助审核。经现有设置页选择 mag47 GPT-6-Luna 后执行成功。plus 辅助审核曾超时，记录为失败尝试，未手动放行以冒充自动通过。
- 专用飞书任务 f5e58518-4617-4632-a4d5-82b29402d52e 首次事件自动进入同一 canonical 伙伴，上传 160 字节文件、回报文字和完成状态，独立 GET 验证成功，随后清理并读回 1470404。
- 普通验收任务 1a572d29-16f7-4056-a3e8-9eead1196cb3 自动交给同一伙伴，真实 38 字节文件上传完成。另用 lark-cli 独立 GET 确认 done/4、原任务附件；插件入口获取的临时链接 HTTP 200，实际下载内容与 SHA-256 相符。没有发主人补充消息或换成 tasks.create。

## 交付边界

插件 0.13.1 完成真实执行；0.13.2 修复已停止测试来源的迟到不存在事件阻断刷新，删减重复界面文案，123 单测、57 界面检查通过；安装后恢复、下载与截图实测完成。证据在独立插件作者仓库 evidence/implementation-v0.13.md。

未验证长期无人值守、断线历史补收、跨设备设置授权及真实网络撤权竞态。插件/客户端仅安装测试实例，未发布正式版。

PR #7718 保持 CLOSED，等待主人验收。最新 upstream/main 513d17de3e60b3cfc735bcba9eecdd8ac064e753 与本地分支只读 merge-tree 在 docs/dev-rules/protocol-compatibility.md 冲突。远端旧 PR head 的 MERGEABLE 不代表当前本地阶段代码可合并。未推送、重开、合并或替代同步；原始 dirty 工作区未动。
