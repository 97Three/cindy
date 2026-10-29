# 插件伙伴委派：协议与回执阶段验收

日期：2026-10-29。范围：用户明确要求先完成插件协议和回执，Core 后续只接审核。

## 已实现

- 独立可选 agent.delegation 声明及 Host 批准事实；旧 tasks/targets 批准不扩权。
- targets.capabilities 发现协议版本和执行就绪状态。当前 execution=false。
- targets.send 的 delegation.task 只支持 bot + queue，最大 8000 字符。
- 现有请求表持久保存版本化 scope、插件实例、目标、请求键和批准版本，不新增表或 migration。
- scope 参与幂等摘要；改 scope、去掉 scope、未知结果、取消、撤权及批准版本变更有专门回归。
- 历史未知字段继续保留；原有安装、能力、凭证和配置不因新增校验失效。
- 作者手册与五种语言的标准 Host 权限标签同步；内置手册 bundle 25。

## 范围边界

未修改伙伴输入协调器、伙伴身份或权限、maker-core、自动审核解析器和 register.ts。
未修改飞书插件，未安装测试/正式客户端，未发送飞书任务或伙伴消息。
运行入口仍显式返回 UNSUPPORTED_CAPABILITY，且不预留或派发委派；通过测试 adapter 验证回执机制不表示真实审核已接通。

## 验证

七个桌面相关测试文件共 491 项通过；协议包 204 项通过。下表为逐文件真实独立运行墙钟。

| 测试文件 | 墙钟秒 | 结果 |
| --- | ---: | --- |
| src/main/cindy-brain/__tests__/pluginTargetSlot.test.ts | 3.087 | 通过 |
| src/main/cindy-brain/__tests__/taskCapability.test.ts | 1.662 | 通过 |
| src/shared/__tests__/ghost.tasks.test.ts | 1.612 | 通过 |
| src/main/cindy-brain/__tests__/ghostInstallReceipt.test.ts | 2.218 | 通过 |
| src/main/cindy-brain/__tests__/GhostManager.test.ts | 10.853 | 通过 |
| src/main/cindy-brain/__tests__/ghostInstallConsent.test.ts | 3.604 | 通过 |
| src/main/maker-ipc/__tests__/pluginTaskStorePagination.test.ts | 4.376 | 通过 |

GhostManager 为既有 325 项真实文件/包安装测试的大套件，此次添加 1 项安装批准生命周期回归；单文件墙钟 10.853 秒。没有增加真实 sleep、模块重载或放宽超时。

### 测试价值

- pluginTargetSlot：生产 handle/assertQueuedDelivery 入口；原接口没有 scoped-send 行为覆盖。最小输入为 bot+queue+delegation，覆盖能力缺失、幂等、取消/未知结果恢复、范围变更和撤权时序。tier=unit。
- taskCapability：生产批准门；最小输入是只有旧 target 批准，断言其仍可用且不授予新 delegation。tier=unit。
- ghost.tasks / manifest.forward-compat：真实两端清单解析器；最小旧快照带历史未知 delegation 值，不能因新字段出现而停用。tier=unit。
- ghostInstallReceipt / GhostManager / ghostInstallConsent：真实批准持久化、包安装和更新入口；只显式批准新能力，保持同实例且仍声明能力时延续批准，移除能力时不保留。tier=unit（复用原文件与 fixture）。
- pluginTaskStorePagination：真实内存 SQLite 目标回执；新版和旧版 scope 在重建 store 后保留，取消不被迟到 accept 覆盖，其他插件行不变。tier=unit（原测试分类）。

桌面与协议包类型检查通过；test-hygiene 通过（默认 origin/main 的既有基线判定）。
权限确认使用既有组件，新增一项权限标签；定向 UI 检查 5 语言 × Light/Dark 共 10 项通过（390×700），已查看 overview。
证据目录：artifacts/ui-check/plugin-install-mail-2RAj5f/。此为 fixture UI，不代表真实安装或授权。
默认 --changed --theme all 因公共 locale/shared 依赖选中了大量无关页面，主动中断；不将该轮记作通过，随后按改动范围完成上述定向检查。

## 下一阶段

在插件授权模块实现当前已接受输入与回执的验证，复用现有输入标识及 Auto 审核解析器；Core 只增加接线。通过撤权、输入切换、旧回执和 owner 边界验证后才设置 execution=true，再由飞书插件启用并进行真实端到端测试。

## Git 与交付边界

原 PR #7718 仍关闭，依照用户先验收要求未重开、未推送或合并。已只读核对 upstream/main ba3ced9368；当前分支与最新 main 在 docs/dev-rules/protocol-compatibility.md 有冲突，尚未执行合并。没有以本地合并替代 PR 流程。
