# dsh-traffic-light · 会话红绿灯

给 DSH 的每个会话点一盏灯，既能贴在 Harness 界面右下角，也能以一个**桌面置顶小窗**的形式一直浮在所有窗口之上，用来随时看"哪个会话在跑、哪个在等我、哪个刚跑完"。

## 形态

| 位置 | 说明 |
| --- | --- |
| 应用内浮层（`shell.overlay`） | 右下角胶囊，点击展开分组列表；可拖动；点击某一行切换到该会话 |
| 桌面置顶小窗（PowerShell WPF） | 无边框深色卡片，`Topmost`，在所有窗口之上；显示同一份灯态；点击某一行让 Harness 切到该会话 |

两者读同一个 host 端点 `GET /api/traffic-light/state`，所以状态永远一致。

## 灯语义

| 灯 | 含义 |
| --- | --- |
| 🔴 呼吸 | 正在等你：审批请求 / 提问未决 |
| 🔴 常亮 + `!` | 这一轮出错（可看 error 文本） |
| 🟡 常亮 | 正在跑（右侧显示 `用时 2分30秒`，计时口径与应用的"用时"一致：本轮开始到现在） |
| 🟢 一直闪烁 | 跑完了、你还没看（未读就一直闪，点灯后转灰、停止闪烁） |
| ⚪ | 空闲 / 中断 / 已读 |

每行右侧是一盏 12px 圆形信号灯：颜色即状态，左边文字只给有信息量的内容（`用时 2分30秒` / `需要您确认` / `等待批准` / `已等 45秒` / `出错`），时长格式与应用会话里的计时完全一致（`N秒` / `N分N秒` / `N小时N分`）。**等待人工介入时灯变红并闪烁**，并按阻塞类型直接写明：待回答的问题是 `需要您确认`，待批准的操作为 `等待批准`，其余等待显示已等时长。标签由宿主给全文、按卡片可用宽度省略（`…`），所以窗口拉宽后标题自然显示更多，不会提前截断；标题过长时也可拖动行内那条 6px 隐形分隔条（鼠标移上去变成左右箭头）**调整标题显示宽度**，双击恢复自适应，宽度记在 `%LOCALAPPDATA%\dsh-traffic-light\companion.json` 的 `labelWidth`；鼠标悬停 250ms 即弹出完整标题；行结构不变时只就地刷新文字，不会每秒重建控件（否则 ToolTip 会被反复销毁而弹不出来）。

小窗标题栏右侧常驻汇总：`待N · 错N · 跑N · 新N · 空闲N`（只显示非 0 项），空闲会话数不再占用底部空间。

子代理不单独占灯位，只挂在父灯上显示 `ˣN`。

## 交互

- **应用内胶囊**：拖动可移动（位置记在 localStorage），点击展开/收起，`Esc` 收起；面板按「等你处理 → 出错 → 运行中 → 刚完成」分组，标题栏右侧显示 `跑N · 空闲N · 另有N条`；点行 → 打开该会话并标记已读；「全部已读」清空绿点。
- **桌面小窗**：拖标题栏移动，**拖右下角**改大小（尺寸与位置、不透明度一起记在 `%LOCALAPPDATA%\dsh-traffic-light\companion.json`，下次启动原样恢复）；右键菜单「不透明度」只调卡片背景，文字与灯始终保持实色，可选 100%–50%，另有「恢复自适应大小」（回到按内容高度自动伸缩）、「标题宽度自适应」（标题列回到按容器等分）、「回到右下角」复位吸附；点行 → 把 Harness 窗口提到前台（最小化会还原）并切到该会话，卡片边框闪一下表示"已切换"（若另一个会话里还留着未发送的输入，应用约 3 秒后会把主视图切回那个会话，属应用自身护草稿行为，插件只重试一次就让位）；菜单另有「打开 Harness」「全部已读」「退出」。Harness 关闭后小窗连续 3 次心跳失败会自行退出，不留孤儿进程。

## 安装

```powershell
# 在 DSH 里（或用 plugin_manager 工具）
plugin_manager action=install_bundle target=E:\Data\DeepSeek\dsh-traffic-light
```

修改代码后需要 `remove_bundle` + `install_bundle` 才会重新加载（桌面小窗会在重新加载时自动重启）。

## 配置（可选）

通过 bundle patch 的 `config` 传给 `apply(ctx, config)`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxLights` | `6` | 浮层/小窗最多显示几盏灯 |
| `titleTtlMs` | `60000` | 会话标题缓存时长 |
| `endpoint` | `/api/traffic-light/state` | 状态端点（同时派生 `/read`、`/focus`、`/focus/ack`） |
| `reconcileMs` | `10000` | 与 agent 注册表对账的周期 |
| `staleIdleMs` | `1800000` | 空闲灯多久后从内存移除 |
| `maxEntries` | `60` | 端点最多返回多少会话 |
| `sortOrder` | `asc` | 组内排序方向：按"用时"（运行中=用时、等你处理=已等、刚完成=本轮耗时）升序 `asc` 或降序 `desc` |
| `desktopWindow.enabled` | `true` | 是否自动拉起桌面小窗 |
| `desktopWindow.refreshMs` | `1000` | 小窗轮询间隔 |
| `desktopWindow.opacity` | `1` | 小窗卡片背景初始不透明度（只影响背景，文字始终实色；右键菜单改动会持久化并覆盖它） |
| `desktopWindow.width` | `300` | 小窗宽度（DIP） |
| `desktopWindow.focusApp` | `true` | 点灯时把 Harness 窗口提到前台（`companion/focus-window.ps1`） |

一个只想要应用内浮层、不要桌面小窗的例子：

```yaml
- insert:
    - id: traffic-light
      name: dsh-traffic-light
      config:
        desktopWindow:
          enabled: false
```

## 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/traffic-light/state` | 全量灯态：`summary`、`sessions`、`focus`、`desktop`、`focusLog`（最近 8 次前置尝试） |
| POST | `/api/traffic-light/state/read` | `{sessionId}` 或 `{all:true}` 标记已读 |
| POST | `/api/traffic-light/state/focus` | `{sessionId}` 把"打开这个会话"排进队列（桌面小窗用） |
| POST | `/api/traffic-light/state/focus/ack` | `{ids:[...]}` 或空数组清空，消费 focus 队列 |
| POST | `/api/traffic-light/state/report` | `{kind,message,sessionId}` 客户端诊断上报（`GET state` 的 `reports` 里能看到最近 12 条） |
| GET | `/api/traffic-light/state/events?sessionId=…&limit=…&only=turns` | 只读诊断：最近 N 条会话事件（类型/序号/时间/工具名，不含工具参数），用来跟应用内计时对账 |

端口只监听 `127.0.0.1`（由 `webServer` 提供），无额外鉴权；如果以后要暴露到局域网，请先加 token。

## 文件

- `index.js` — host 聚合器：订阅 agent / session 事件，维护 `Map<sessionId, LightState>`，颜色归并、标题缓存、已读持久化、四条路由、拉起桌面小窗。
- `client.js` — 应用内浮层（`shell.overlay`，order 400）：胶囊 + 分组面板 + 拖拽 + focus 消费。
- `companion/traffic-light.ps1` — 桌面置顶小窗（WPF，`Topmost`，单实例 Mutex，心跳自退）。
- `companion/focus-window.ps1` — 点灯后把 Harness 主窗口提到前台（`AppActivate` → `BringWindowToTop`/`SetForegroundWindow`）。
- `cordis.patch.yml` — bundle patch（insert `traffic-light`）。
- `locale/{en,zh}.json`、`icon.svg` — 展示元数据。
