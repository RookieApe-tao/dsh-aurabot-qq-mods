# 我的世界服务器分身（mc-rcon）

让 Aurabot 住进 Minecraft Java 版服务器：**在游戏聊天里像群聊一样接话**，有人死了会调侃一句，能按权限帮玩家执行服务器操作（旁观、tp、back、出生点），换端时自动找到正在运行的服务器。

- 不用装服务端插件：只靠 RCON + 服务器自带的 `logs/latest.log`。
- 支持单机 / 局域网 / 有 RCON 的远程服务器。
- 权限分级：游戏内管理员、普通玩家、QQ 主人各管各的。

## 功能

| 功能 | 说明 |
|---|---|
| 游戏聊天接话 | 默认每条聊天都交给她判断，被唤醒词叫到必回，其他可接可沉默；同一玩家连发会合并 |
| 人格卡 | 回应前读取 Aurabot 当前人格卡，用她的口气说话，不额外调用 QQ 会话 |
| 死亡播报 | 识别中英文死亡消息（烧死、摔死、被杀、岩浆、闪电…），主动调侃/关心一句 |
| 服务器操作 | 管理员可执行较广命令；普通玩家可申请切旁观/生存、tp 到坐标、back、spawn、查在线/时间 |
| 跨维度 tp | 识别「主世界 / 下界 / 末地 / 完整维度 id」，跨维度先确认，回「是」才执行 `execute in` |
| 换端自动检测 | 扫描服务器根目录，读每个服 `server.properties`，用日志时间 + RCON 试连找出正在跑的，自动切过去 |
| QQ 侧控制 | 主人在 QQ 里用 `/mc status/list/say/cmd/recent/on/off/test` |
| 面板 | 连接状态、在线玩家、最近聊天、手动执行/广播、服务器自动检测 |

## 安装前准备

1. **服务器开启 RCON**（`server.properties`）：

   ```properties
   enable-rcon=true
   rcon.port=25575
   rcon.password=换成你自己的密码
   ```

2. **能读到服务器日志**：`<服务器目录>/logs/latest.log`。纯 RCON 收不到别人的聊天，只能靠日志；服务器在另一台机器时，用文末的 HTTP 转发。
3. Aurabot 插件版本 ≥ 1.2.0，扩展接口 v1。

## 配置

装好后打开面板「已安装 → 我的世界服务器分身」，至少填这四项：

| 设置 | 说明 |
|---|---|
| RCON 地址 / 端口 / 密码 | 对应 `server.properties` 的 `rcon.*` |
| 服务器日志路径 | `<服务器目录>/logs/latest.log` 的完整路径 |

然后按需设置：

- **必回唤醒词**：一行一个，出现就一定回应（建议填她的名字，例如「小助手」）
- **其他称呼 / 感兴趣的话题 / 随机插话概率**：控制普通聊天里多主动
- **接话方式**：`每条都看`（默认）/ `智能接话` / `只回应召唤`
- **游戏内管理员**：一行一个玩家名，可执行较广命令
- **普通玩家可用操作**：默认 `gamemode / tp / back / spawn / list / time query`
- **禁止执行的命令**：默认 stop、ban、op、deop、whitelist、kick 等，管理员也拦
- **跨维度 tp 先确认**、**维度别名**：加上你的模组维度，例如 `暮色=twilightforest:twilight_forest`
- **死亡时主动说话**、**自动检测正在运行的服务器**、**服务器根目录**

## 权限

| 身份 | 能做什么 |
|---|---|
| QQ 主人（`ownerQQ`） | `/mc` 全部子命令，包括任意 RCON 命令（不受禁止名单限制） |
| QQ 管理员（面板 `qqAdmins`） | 同上，但需在插件私聊/群白名单里 |
| 游戏内管理员 | 可让她执行较广的服务器命令（受禁止名单限制） |
| 普通玩家 | 只能申请安全操作；其他命令由模块直接拦截（不依赖模型自觉） |
| 允许互动名单 | 留空 = 所有玩家；填了只回应名单内玩家 |

普通玩家的命令会在模块里校验参数并自动补上请求者自己：

- `gamemode spectator/survival`：只能改自己
- `tp <x> <y> <z>`：只能传自己，坐标有范围校验
- `back`：回到上一次 tp 之前的位置（模块记录，不依赖服务端 `/back`）
- `spawn`：只能自己
- `list` / `time query`：只读
- 面板里可以加无参数命令（例如 `home`），整条匹配才放行

## 会访问哪里

| 能力 | 用途 |
|---|---|
| `network` | 只连接你在面板/配置里填的 RCON 地址（默认 `127.0.0.1:25575`），不上传任何数据 |
| `filesystem` | 只读取你填的 `logs/latest.log`（以及自动检测时读候选目录的 `server.properties` 和日志时间） |
| `plugin-config` | 通过 `api.config()` 读当前人格卡 id；自动换端时用 `api.saveSettings()` 更新本模块设置 |
| `plugin-internals` | `api.core.personas` 读人格卡、`api.core.hub.turnSendersAllOwner` 判断主人会话、`api.core.http` 读面板请求 |

不访问数据库、不抓网页、不发 QQ 群消息、不下载或执行任何外部代码。

## 外部转发（服务器在别的机器上）

面板填「外部转发 token」后，让服务器端把聊天 POST 过来：

```bash
curl -X POST http://<Aurabot 所在机器>:<面板端口>/aurabot/api/ext/mc-rcon/ingame \
  -H "content-type: application/json" \
  -H "x-mc-token: <你填的 token>" \
  -d '{"player":"Steve","text":"小助手 在吗"}'
```

支持 GET（`?token=&player=&text=`）。日志监听和转发可同时开，重复消息 2 秒内去重。

## 已知限制

- 纯 RCON 只能「发命令、收回执」，读不到别人聊天；聊天监听依赖日志文件。
- 日志轮转（每天 0 点 / 服务器重启）时会自动重新打开 `latest.log`；如果日志被移到别的目录，需要手动改路径。
- 多个服务器共用同一个 RCON 端口时，自动检测靠「日志最新」判断谁在跑。
- 死亡消息是本地化文本；如果某个模组改了死亡消息格式，可能识别不出（面板可关掉死亡播报）。
- 管理员命令由模型生成，模块只做权限门和参数校验；不会执行 `blockedCommands` 里的命令。

## 文件

```
index.mjs          入口：配置、接话判断、权限、命令、工具、面板接口
panel.js           状态面板
lib/rcon.mjs       RCON 协议客户端
lib/logwatch.mjs   日志跟随与聊天/死亡消息解析
lib/prompt.mjs     人格卡提示词与 <mc> 命令解析
lib/commands.mjs   权限白名单与参数校验
lib/dimension.mjs  维度识别
lib/discover.mjs   服务器自动发现
test/              单元测试（不发布）
```

## 许可证

MIT
