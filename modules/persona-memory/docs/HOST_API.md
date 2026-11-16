# Aurabot 宿主接入评审

人设记忆管理通过 Aurabot 提供的 `api.core.personaMemoryBridge` 接管互动记忆。宿主保留会话归属和执行状态，模块负责本地档案、回忆与整理。当前 v1 契约来自开发适配环境，请维护者确认可沿用的既有接口、需要新增的接口及可发布的宿主版本。

本次对照了 [Aurabot 主线 API](https://github.com/aureth-labs/dsh-aurabot-qq/blob/a138d14e3215f052dfa7d6a9dd16c0e409d9752d/src/modules/API.md) 与 [市场 CI 使用的 1.3 分支 API](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e4a6526b8bbc4238a4e9acba60f4bd857cf08849/src/modules/API.md)。

| 宿主能力 | 已有入口 | 需要确认的语义 |
| --- | --- | --- |
| 聊天事件 | `message` 可观察入站消息。 `reply`、`reply/items` 和 `send` 在发送前调用。 | 提供稳定事件 ID、明确的角色和聊天归属，以及发送成功后的事件和回执 ID。失败、取消、模拟发送和重复回执可区分。 |
| 模型请求前投影 | `prompt` 可修改交给会话的新内容，`context` 可追加文字。 | DSH 需在请求冻结前提供只对已登记 Aurabot 会话生效的投影，替换旧回忆和完整旧回合并保留工具交换的边界。请求 ID 与用量可关联，回复结束或取消后旧投影退出。 |
| 原生记忆交接 | `api.use('memory')` 可访问原生记忆，模块系统有启停与重载。 | 接管前停止原生与 `history-vault` 的在途写入和注入，确认各时刻只有一个供给方。切回原生时用同一档案和遗忘边界，关闭与恢复操作须有持久化状态。 |
| 按角色停止和归档 | `hub.sessions()` 可查询当前映射，`resetChat(chatId)` 按聊天重置映射。 | 预览明确登记的角色、聊天和会话 ID。执行前复核范围，等待目标会话停止并拒绝迟到写入。用户选择隐藏旧窗口时，由 DSH 工作区接口归档这些 ID。角色卡、其他人格及普通工作区保留。 |

## 当前 v1 契约

- 宿主在模块加载前标识 `api: 1`，声明可验证的能力并提供绑定、配置、解绑和当前角色接口。模块经 `configure` 提交迁移器与重置参与方。
- `prepare` 返回已验证的预览。 `activate` 成功时报告 `verified: true, singleProvider: true`。 `pause` 成功时报告 `verified: true, contextCleared: true`。 `prepareNative` 和 `activateNative` 负责切回同一档案。
- `previewSessionReset`、`validateSessionReset` 和 `clearSessions` 共用同一份目标名单。归档失败保留待完成的重置，重试按原预览目标继续。扩展资料由匹配的参与方处理。
- 后台日/月整理会给 `model` 传可选的 `reasoningEffort: 'off'`，请宿主只在提供方支持时使用。返回值可包含 `finishReason` 与实际用量，供模块识别输出截断。原生整理和正常聊天使用各自的模型设置。
- [入口预检](../lib/host-contract.mjs) 对接口版本、能力和方法校验。缺失或不完整时，模块只注册面板兼容状态。模块本身的版本号按市场规范登记，支持范围由可用宿主能力决定。

请确认在 Aurabot / DSH 中应从哪些已支持入口提供上述语义，以及是否采用此 v1 契约或调整其形态。确认后以第一个实际提供接口的版本作为市场兼容基线，并在干净实例验证市场安装、第二版更新和数据保留。

## 复审测试

在市场仓库根目录运行：

```sh
node --test "modules/persona-memory/test/*.test.mjs"
npm run catalog
npm run check
npm run pack
```

市场 CI 为模块测试加载 Aurabot 源码。可设 `AURABOT_PLUGIN_DIR` 后运行 `node --import ./scripts/plugin-env.mjs --test "modules/persona-memory/test/*.test.mjs"`，同时检查原版模块加载和缺接口保护。模块测试覆盖接管失败、启停、请求投影、原生档案接续、重置和迟到写入。宿主和 DSH 的端到端接管需要在配套环境运行。
