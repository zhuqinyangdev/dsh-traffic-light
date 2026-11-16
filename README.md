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
| 🟠 常亮 | 异常：这一轮结束了但不干净（如输出被截断、撞上输出上限），右侧写明 `异常 · 输出被截断` |
| 🟢 一直闪烁 | 跑完了、你还没看（未读就一直闪，点灯后转灰、停止闪烁） |
| ⚪ | 空闲 / 中断 / 已读 |

每行右侧是一盏 12px 圆形信号灯：颜色即状态，左边文字只给有信息量的内容（`用时 2分30秒` / `需要您确认` / `等待批准` / `已等 45秒` / `出错` / `异常 · 输出被截断`），时长格式与应用会话里的计时完全一致（`N秒` / `N分N秒` / `N小时N分`）。**等待人工介入时灯变红并闪烁**，并按阻塞类型直接写明：待回答的问题是 `需要您确认`，待批准的操作为 `等待批准`，其余等待显示已等时长。**异常用橙色**（不是红色：任务没失败，只是结果可能不完整），点开看过就转灰。标签由宿主给全文、按卡片可用宽度省略（`…`），所以窗口拉宽后标题自然显示更多，不会提前截断；标题过长时也可拖动行内那条 6px 隐形分隔条（鼠标移上去变成左右箭头）**调整标题显示宽度**，双击恢复自适应，宽度记在 `%LOCALAPPDATA%\dsh-traffic-light\companion.json` 的 `labelWidth`；鼠标悬停 250ms 即弹出完整标题；行结构不变时只就地刷新文字，不会每秒重建控件（否则 ToolTip 会被反复销毁而弹不出来）。

小窗标题栏右侧常驻汇总：`待N · 错N · 异N · 跑N · 新N · 空闲N`（只显示非 0 项），空闲会话数不再占用底部空间。

子代理不单独占灯位，只挂在父灯上显示 `ˣN`。

## 交互

- **应用内胶囊**：拖动可移动（位置记在 localStorage），点击展开/收起，`Esc` 收起；面板按「等你处理 → 出错 → 异常 → 运行中 → 刚完成」分组，标题栏右侧显示 `跑N · 异N · 空闲N · 另有N条`；点行 → 打开该会话并标记已读；「全部已读」清空绿点。胶囊摘要里的「待处理」把 等待 + 出错 + 异常 一起算。
- **桌面小窗**：拖标题栏移动，**高度随行数自适应**（不再能拖高），只有**宽度可拖**（右下角左右箭头；宽度、位置、不透明度、最大高度一起记在 `%LOCALAPPDATA%\dsh-traffic-light\companion.json`，下次启动原样恢复）；右键菜单「最大高度」可选 自适应 / 200 / 300 / 400 / 520 / 640 px，超过就变成上下滚动，滑到底不会把卡片撑长（列表右侧是一条**自绘的 2px 细滚动条**，只有滑块没有轨道，鼠标移上去变亮、按住可直接拖动）；「不透明度」只调卡片背景，文字与灯始终保持实色，可选 100%–50%，另有「宽度恢复默认」「标题宽度自适应」（标题列回到按容器等分）、「回到右下角」复位吸附；点行 → 把 Harness 窗口提到前台（最小化会还原）并切到该会话，卡片边框闪一下表示"已切换"（若另一个会话里还留着未发送的输入，应用约 3 秒后会把主视图切回那个会话，属应用自身护草稿行为，插件只重试一次就让位）；菜单另有「打开 Harness」「全部已读」「退出」。Harness 关闭后小窗连续 3 次心跳失败会自行退出，不留孤儿进程。

## 安装

在 DSH 的「添加插件」对话框里粘贴仓库地址即可（会自动 `pnpm add git+https://…`）：

```
https://github.com/zhuqinyangdev/dsh-traffic-light
```

或用 plugin_manager 工具 / 本地目录：

```powershell
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
| `desktopWindow.width` | `300` | 小窗宽度（启动默认值；用户拖右下角改过宽度后以持久化的 `companion.json` 为准） |
| `desktopWindow.maxHeight` | `0` | 小窗最大高度（DIP）：`0` = 高度随行数自适应；`>0` = 到该高度后行列表上下滚动。之后以小窗右键菜单「最大高度」的选择为准（持久化到 `companion.json`） |
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
| POST | `/api/traffic-light/state/debug/anomaly` | **测试用**：`{title?,workspace?,warning?,seconds?}`（默认 90 秒，上限 600）往状态里插一条假的「异常」行，用来查看橙灯外观；到期自动消失 |
| POST | `/api/traffic-light/state/debug/clear` | 清掉上面插入的所有假行 |

端口只监听 `127.0.0.1`（由 `webServer` 提供），无额外鉴权；如果以后要暴露到局域网，请先加 token。

## 文件

- `index.js` — host 聚合器：订阅 agent / session 事件，维护 `Map<sessionId, LightState>`，颜色归并、标题缓存、已读持久化、四条路由、拉起桌面小窗。
- `client.js` — 应用内浮层（`shell.overlay`，order 400）：胶囊 + 分组面板 + 拖拽 + focus 消费。
- `companion/traffic-light.ps1` — 桌面置顶小窗（WPF，`Topmost`，单实例 Mutex，心跳自退）。
- `companion/focus-window.ps1` — 点灯后把 Harness 主窗口提到前台（`AppActivate` → `BringWindowToTop`/`SetForegroundWindow`）。
- `cordis.patch.yml` — bundle patch（insert `traffic-light`）。
- `locale/{en,zh}.json`、`icon.svg` — 展示元数据。

## 发布（让同事在「添加插件」里直接装）

「添加插件」对话框接受三种输入：**npm 包名**、**GitHub 仓库地址**、**本地目录路径**。所以要走前两种，得先把包发到对应渠道。

### 路线 A：GitHub（最快，免费，不用改包名）

```powershell
cd <仓库目录>
git remote add origin https://github.com/<你的账号>/dsh-traffic-light.git
git push -u origin main
```

然后在 GitHub 仓库的 **About → Topics** 里加 `dsh-plugin`（插件商店靠这个 topic 发现它）。
同事在「添加插件」里粘贴 `https://github.com/<你的账号>/dsh-traffic-light` 即可安装，商店列表里也会出现。

### 路线 B：npm（包名要换，`dsh-traffic-light` 已被别人占用）

```powershell
npm login          # 或直接配 .npmrc 的 authToken
npm publish        # 需要 package.json 里没有 "private": true（本仓库已去掉）
```

同事在「添加插件」里粘贴包名（例如 `dsh-traffic-light-hud`）。

### 路线 C：商店内「一键发布」

插件商店 → 发布 → 填 Markdown 介绍 + 配 GitHub / npm token → 一键发布（自动建仓、打 `dsh-plugin` topic、推 release、npm publish），发布前会过安全扫描与 8 项质量门禁。

### 质量门禁自查（发布前）

- `package.json`：`name` / `version` / `description` / `license` / `keywords`（含 `dsh-plugin`）/ `exports` 齐全，**不能有 `private: true`**
- 仓库根有 `README.md`、`LICENSE`
- `files` 覆盖所有运行时文件（本仓库：`index.js`、`client.js`、`companion/*.ps1`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`）
- 版本号与 README 更新日志、profile 里的安装来源一致（商店的 version-guard 会核对）

## 更新日志

### 1.0.9

- 应用内浮层：点面板以外任何地方（对话区、侧栏、标题栏）自动收起，Esc 同样生效——不用再点胶囊才关。
- 收起态胶囊文案改为 **运行中 / 已完成 / 需确认** 三个数字（出错、异常有值时额外追加），比原来的"运行 · 待处理 · 未读"更直白。
- 「已完成」= **未读的完成数**：点「全部已读」或点过某一行后清零，和绿灯一个口径。
### 1.0.8

- 滚动条改为**自绘 4px 滑块**：原生 `ScrollBar` 的宽度无法从模板里改（设成 4/2 实际仍渲染 5–7px），改为隐藏原生条、自己用 `Border` 画滑块，宽度、圆角、悬停色全部可控，位置随滚动同步、可按住拖动。
- 状态圆灯 12px → **14px**；卡片左右留白 10→8、上下 8→6；状态文字与圆灯之间留 6px 空隙。
- 关闭窗口时立即保存宽度/位置（不等防抖），避免"拖完马上关掉、下次没记住"。
- 渲染异常会写 `%LOCALAPPDATA%\dsh-traffic-light\companion-error.log`（平时为空）。

### 1.0.7

- 滚动条再细一档：4px 宽、圆角 2、滑块最小高度 22，行容器右侧空隙同步收到 7px。

### 1.0.6

- 修掉列表滚动条与行尾状态（meta 文案 / 圆灯）重叠：行容器右侧留 9px 内边距，6px 细条不再压住内容。

### 1.0.5

- 桌面小窗的列表滚动条从系统原生样式换成自绘的 **6px 圆角细条**：无灰色轨道、无上下箭头，鼠标悬停变亮、按住可拖动（`ScrollBar` 模板用 XAML 注入，见设计文档技术债 20）。

### 1.0.4

- 小窗高度改为**永远随内容自适应**，只能拖宽度（右下角把手改成左右箭头）。
- 新增「最大高度」菜单（自适应 / 200 / 300 / 400 / 520 / 640 px）：超过上限后行列表上下滚动，卡片不再被撑长；上限记在 `companion.json`，配置项 `desktopWindow.maxHeight` 只做启动默认值。
- 修掉一个会把列表越缩越小的反馈回路：滚动上限改为固定值，不再由窗口高度反推。

### 1.0.3

- 新增测试入口 `POST /api/traffic-light/state/debug/anomaly`（可带 `title/workspace/warning/seconds`）：往状态里插一条临时「异常」行，方便直接看橙灯长什么样，到期自动消失，`/debug/clear` 可立即清掉。

### 1.0.2

- 新增「异常」状态（橙灯）：一轮结束但结果不干净时（典型是撞上输出上限、回答被截断），小窗与浮层显示 `异常 · 输出被截断`，标题栏计 `异 N`，未读时参与未读计数，点开看过转灰。此前这种情况会被当成普通的"已完成"，看不出结果被截断。

### 1.0.1

- 计时改为与应用同源（取 `turn/start` 事件时间），重装后估算的起点会被真实事件时间纠正，界面用 `≈` 标注估算期。
- 组内排序按用时（`sortOrder` 可选 `asc`/`desc`），避免会话位置乱跳。

### 1.0.0

- 首个公开版本：host 聚合器（事件订阅 + 计时 + 已读持久化 + 5 条只读/操作端点）、应用内浮层（`shell.overlay`）、Windows 桌面置顶小窗（WPF，单实例、心跳自退、位置/尺寸/不透明度/标题宽度记忆）、点灯前置窗口 + 切会话、`ask_user_question` 等待红闪与自动清除。
