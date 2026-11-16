# 房间（Aurabot 模块）

给她一个自己的 3D 房间。屋里有窗、有阳台、有厨房和书房；家具一开始全空着，摆什么你自己定。
她**看得见**自己在哪儿——不是靠猜，是每轮对话里真的带着位置事实。

- 装好后房间里是**空的**（没有家具、没有猫）
- 只有**一个角色：大肥鱼**，就是她自己
- 装之前的样子、别人家的布置，都不会跟过来

## 装法

把整个 `room3d/` 文件夹放进 Aurabot 的模块目录：

```
plugins-data/aurabot/modules/room3d/
├── module.json
├── index.js
├── panel.js
└── lib/
    ├── index3d.html
    └── vendor/       # three.js 等
```

放进去几秒内自动加载，不用重启。面板「已安装」里能看到 `room3d`，
它自己有一页「房间」，点开就是 3D 房间。

**动作视频（106 个 .webm，约 52MB）不在模块包里**：装好后模块会自动从素材仓
（`roomAssetUrl` 设置，默认 [room3d-assets](https://github.com/RookieApe-tao/room3d-assets/releases/download/v1/room3d-assets.zip)，可换镜像直链）
下载落位到 `modules-data/room3d/assets/`；下载失败不影响别的功能，每 10 分钟自动重试，
也可 `POST /aurabot/api/ext/room3d/api/room/fetch-assets` 手动重下。旧版把素材放在模块目录
`assets/` 里的，升级后启动时自动搬进数据目录，不用重新下载。

需要 Aurabot 插件 `1.2.0` 以上、模块接口 `api: 1`。

### 素材没就绪时只显示影子？

动作视频（.webm）没下载成功时，房间里的角色只剩一团阴影和名字标签，不是模型坏了。
面板「房间」页会显示素材状态和「重新下载素材」按钮；`GET /health` 的 `assets` 里也能看到
`ready`、`lastError` 和提示。GitHub 直连失败时，把上面「动作素材包下载地址」换成可访问的
https 镜像直链，再点「重新下载素材」即可；旧版错误落位的反斜杠文件名会在模块启动时自动修正。

## 她会怎么「看见」房间

每一轮对话，模块都会往提示词的用户消息一侧塞一小段位置事实（不动系统提示，
所以前缀缓存不会失效）：

```
【你在自己家里，一个 3D 小房间】
现在是夜里，灯已经关了，屋里有点暗；窗外是深蓝一片，只有月光。
你现在在客厅沙发（12 分钟，想靠着歇会儿）。
位置随时会变（你自己走或者被安排），问到就按上面说，别说「瞬移」…
```

你问到「你在哪 / 屋里什么样 / 窗外」时，会再附一段完整画面（光线、家具清单、窗外天色）。

另外给她的两个工具：

| 工具 | 作用 |
|---|---|
| `look_at_room` | 抬头看一眼房间（随时能看，返回文字画面） |
| `go_room_spot` | 走到某个位置（`sofa` `bed` `kitchen` `desk` `balcony` `door`） |

## 摆家具

房间页面右上角：

- **✎ 家具**：家具目录、拖动、旋转、缩放、换材质
- 地板、猫的入口也在旁边

这些入口都要**管理密码**。默认密码是 `0000`，第一次进就改成你自己的：
面板 → 房间模块设置 → 「房间管理密码」。密码不会写死进 HTML，
每次发页面时按设置填进去。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `adminPin` | `0000` | 房间管理密码 |
| `perception` | 开 | 每轮让她知道自己在哪儿；关掉完全不加 token |
| `roomAssetUrl` | room3d-assets Release 直链 | 动作素材包下载地址，可换镜像 |

`perception` 关掉以后，`look_at_room` 工具照样能用，只是她不会「一直知道」。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /aurabot/api/ext/room3d/page` | 3D 房间页面 |
| `GET /aurabot/api/ext/room3d/situation` | 她现在「眼里」是什么样（调试用） |
| `GET/POST /aurabot/api/ext/room3d/perception` | 开关位置注入 `{"enabled": false}` |
| `GET/POST /aurabot/api/ext/room3d/api/room/*` | 房间状态、家具、猫、相机、日志 |
| `POST /aurabot/api/ext/room3d/api/room/fetch-assets` | 手动重下动作素材包（body 留空 `{}`） |

## 数据

状态存在模块自己的数据目录，**不放在模块目录里**：

```
modules-data/room3d/
├── assets/               # 动作视频（自动下载落位）
├── room-state.json       # 她在哪儿、房间日志
├── furniture.json        # 家具、隔断、猫
├── cats-live.json
├── camera.json
└── floor.json
```

> 这点很重要：Aurabot 每 3 秒扫一次模块目录，模块目录里任何文件变动都会触发整个模块重载。
> 状态要是写在模块目录里，页面一写状态就重载一次，页面重连再写，会一直刷新。

## 已知限制

- 动作视频是 .webm，Safari 上可能播不出来（Chrome / Edge / Firefox 正常）
- 3D 场景对显卡有一点要求，软渲染的机器会掉帧
- 猫和家具都是前端存的，清掉 `modules-data/room3d/` 就等于重新装修

## 自测

```bash
node --check index.js     # 语法
curl http://127.0.0.1:6180/aurabot/api/ext/room3d/situation   # 看注入的文字
```

## 授权

本模块自研代码 MIT，作者：zcx1021。

`lib/vendor/` 下的 three.js r160（`three.module.js` / `OrbitControls.js` /
`RoundedBoxGeometry.js`）是原样分发的第三方代码，同 MIT；来源、版本、文件对应关系
与许可原文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

动作视频（.webm）不随本仓库分发，从独立素材仓按需下载。
