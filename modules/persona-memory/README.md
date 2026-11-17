# 人设记忆预览

在 Aurabot 模块面板中查看当前人格与主人的 QQ 私聊原生记忆。每页显示 20 条正文及时间。面板也显示宿主确认的私聊送达次数及最近时间。记忆的记录和召回仍由 Aurabot 原生模块处理。

需要包含 [宿主 PR #465](https://github.com/aureth-labs/dsh-aurabot-qq/pull/465) 的 Aurabot 1.3 系列版本，并已设置主人 QQ、当前人格及资料归属。调试模式、归属未设置或原生记忆不可读时，面板会提示当前条件。安全模式按宿主规则禁用第三方模块。

预览只接受宿主已确认的当前人格主人私聊，群聊和其他私聊都不会进入面板。模块仅在自己的 `api.dataDir('preview-delivery.json')` 保存对应范围的送达次数、更新时间和范围摘要。数据不包含记忆正文、QQ 号或消息 ID，不向外发送。增强记忆、编辑、迁移及重置仍属于后续完整版。

## 本地验证

把 `AURABOT_PLUGIN_DIR` 指向包含 #465 的 Aurabot 源码，在市场仓库根目录运行测试。

```sh
node --import ./scripts/plugin-env.mjs --test "modules/persona-memory/test/*.test.mjs"
```

作者 Yobak，反馈 QQ 1365641547。
