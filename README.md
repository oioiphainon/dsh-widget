# 桌面工鱼（Desk Fish · DSH 任务进度悬浮鱼）

一只真正**悬浮在 Windows 桌面上**的小鱼：始终置顶、透明背景、可拖拽，**实时显示当前
DSH 会话的任务进度**。关掉 DSH 窗口（甚至整个 DSH 程序）之后，鱼还留在桌面上。

> **快速安装**（Windows + DeepSeek Harness）：
> ```powershell
> dsh plugin --profile desktop add github:oioiphainon/dsh-widget
> ```
> 装完桌面右下角立刻出现一条工鱼🐟 · 其它装法见下方[安装](#安装)一节。

- 🐟 **桌面级置顶**：独立的 WinForms 分层窗口（per-pixel alpha），浮在所有应用之上，
  不属于 DSH 窗口，所以窗口最小化/关闭都不会带走它。
- 📊 **实时进度**：Host 每 0.8 秒把「最近活跃会话」的进度写成一个小 JSON，挂件读它，
  显示阶段（排队 / 思考 / 输出 / 执行工具 / 完成 / 出错）、轮次、步骤、工具次数、用时。
- 🔧 **正在做什么**：当前工具名 + 目标（`grep`、`pwsh`、`todo_write`… 有中文别名）。
- ☑️ **任务清单**：todo 完成度百分比、进度条与逐条清单（✓ / ◐ / ○）。
- ⚙️ **更多上下文**：后台任务、会话目标（第 n/m 轮）、团队任务，以及其它正在跑的会话数。
- 🖱 **交互**：拖动整只鱼换位置；点一下鱼在「气泡」和「详情面板」之间切换；右键菜单可
  展开/收起、改大小（小/中/大）、归位、退出。位置与状态记在
  `%LOCALAPPDATA%\dsh-fat-fish\widget.json`。
- 🌙 **关掉 DSH 后**：超过 7 秒没有新数据，气泡会变成「DSH 未运行 / 桌面工鱼在桌面上等你
  回来」，鱼继续待在桌面上；DSH 再启动就会自动接上。
- 🔔 **审批提醒**：DSH 需要你审批时，气泡变琥珀色「需要你审批」，鱼上挂 `!` 角标、响提示音，
  点卡片直接把 DSH 窗口提到最前；处理完闪 6 秒「已允许 / 已拒绝」。

| 干活中 | 需要你审批 | 已允许 | 展开面板 |
| --- | --- | --- | --- |
| ![progress](docs/preview-progress.png) | ![approval](docs/preview-approval.png) | ![allowed](docs/preview-allowed.png) | ![expanded](docs/preview-expanded.png) |

## 结构

```text
dsh-widget/
├── package.json                  # bundle 元数据
├── cordis.patch.yml              # 挂载行：id dsh-fat-fish-widget
├── index.js                      # Host：进度折叠 + 状态落盘 + 拉起桌面挂件
├── desktop/
│   ├── FatFishDesktop.ps1        # 桌面挂件（Windows PowerShell 5.1，纯 ASCII 源码）
│   ├── strings.json              # 全部中文文案（脚本按 UTF-8 读，避免代码页问题）
│   ├── fish.png                  # 透明抠图
│   └── launch-widget.vbs         # 静默启动器（无黑框；由 Host 在 DSH 启动时调用）
├── assets/                       # 原图与抠图源文件
├── icon.png                      # 插件列表图标
├── locale/{zh,en}.json           # 插件管理里的标题与描述
└── legacy/                       # 旧版「界面内悬浮层」实现，已停用，仅留档
```

## 数据怎么流动

```text
DSH Host (index.js)
  ├─ session/event、agent/status  →  折叠出 progress / approvals
  ├─ 事件后 120ms 补写 + 800ms 心跳原子写 state.json  →  %LOCALAPPDATA%\dsh-fat-fish\state.json
  ├─ 启动时拉起桌面挂件（单选实例，重复拉不会重复开）
  └─ GET /api/fat-fish/progress    （调试用，需浏览器认证）

桌面挂件 (FatFishDesktop.ps1)
  └─ 每 180ms 读 state.json → 画在置顶透明窗口上
```

`state.json` 就是路由响应体加一个 `writtenAt`（毫秒时间戳），挂件靠它判断数据是否新鲜。

```jsonc
{
  "ok": true, "v": 1, "now": 0, "version": "0.3.2", "writtenAt": 0,
  "counts": { "live": 1, "running": 1 },
  "approvals": [{
    "id": "approval-1", "sessionId": "session-1", "sessionTitle": "…",
    "toolName": "plugin_manager", "reason": "…", "target": "…", "at": 0
  }],
  "lastApproval": {
    "id": "approval-1", "sessionId": "session-1", "sessionTitle": "…",
    "toolName": "plugin_manager", "outcome": "allowed-once", "at": 0
  },
  "sessions": [{
    "id": "session-1", "title": "…", "cwd": null,
    "running": true, "phase": "tool",
    "turn": 3, "step": 7, "turnStartedAt": 0, "elapsedMs": 12345, "lastEventAt": 0,
    "currentTool": { "name": "grep", "target": "…", "startedAt": 0 },
    "counts": { "tools": 12, "errors": 0, "steps": 7 },
    "todos": [{ "content": "…", "status": "in_progress" }],
    "todoProgress": { "done": 2, "total": 5 },
    "jobs": [{ "id": "bash-1", "label": "…", "status": "running", "progress": null, "startedAt": 0 }],
    "goal": null,
    "teamTasks": null
  }]
}
```

## 使用

- **无底色贴桌面**：素材是透明 PNG（`desktop/fish.png`），鱼身上没有白色圆盘/描边，
  收起时就是「一张气泡 + 一只鱼」。
- **拖动**：按住鱼拖到任意位置（虚拟屏幕范围内，自动记住）。
- **展开/收起**：单击鱼；或右键 → 展开详情 / 收起。
- **大小**：右键 → 大小 → 小 / 中 / 大。
  三档之上还有一层全局缩放 `$script:UiScale`（`desktop/FatFishDesktop.ps1` 里，默认 `1.12`）：
  几何走 `U()`、字号乘同一个系数，卡片、鱼和文字一起等比放大，不会出现「字小框大」。
  改完重启挂件生效（右键 → 退出，再双击 `desktop\launch-widget.vbs`）。
- **归位**：右键 → 回到默认位置（右下角，避开 `dsh-whale-widget` 的鲸鱼）。
- **退出**：右键 → 退出；或结束进程 `powershell.exe`（窗口标题 `FatFishDesktop`）。
- **隐藏 / 恢复**：右键 → 「隐藏悬浮窗」把整只鱼（气泡 + 鱼）藏起来，进程仍在后台
  轮询，隐藏期间不弹提示音。恢复方式（任选其一）：
  - **点系统托盘里的小鱼图标**（推荐，最直接）——挂件常驻托盘，左键一点就恢复；
    隐藏时鼠标悬停会提示「桌面工鱼已隐藏 - 左键点击恢复」，右键还有完整菜单；
  - 再启动一次 `desktop\launch-widget.vbs`（双击即可，或重新打开 DSH / 重载插件）——
    第二次启动拿不到单实例锁，会给正在运行的挂件留一个 `show-request`，隐藏的鱼随即
    回到桌面。
  隐藏**不持久化**（避免下次登录看不见鱼还以为坏了），下次启动照常出现。
- **开机自启（可选）**：右键 → 「开机自启」打勾 / 取消。打勾会在
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FatFishDesktop.lnk`
  建一个指向 `desktop\launch-widget.vbs` 的启动项，登录桌面就有鱼（DSH 没开时显示
  「DSH 未运行」）；取消即删除。**默认关闭**，启动文件夹里有没有快捷方式就是开关
  的唯一依据，手动删掉快捷方式菜单里的勾也会跟着消失。
- **DSH 退出后保留悬浮窗（可选）**：右键 → 「DSH 退出后保留悬浮窗」打开（默认）/ 关闭。
  关闭后挂件会在检测到 Host 停止写快照（约 30 秒宽限）后自己退出，适合「只在用 DSH
  时出现」；打开则一直留在桌面上。选择持久化在 `widget.json` 的 `keepAfterExit`。
- **随 DSH 启动**：挂件由 **DSH 宿主（Host）加载本插件时**在 1.5 秒内自动拉起——
  打开 DSH 就有鱼。挂件启动后独立于 DSH 存在：关掉 DSH 窗口鱼不会消失（显示
  「DSH 未运行」），下次 DSH 启动时如鱼还在，会被单实例互斥锁忽略，不会叠出第二只。
- **立刻启动**：双击 `desktop\launch-widget.vbs`（无黑框）；或直接把 DSH 打开。

## 审批提醒

DSH 把审批请求作为可持久化的会话事件写进日志（`approval/asked` / `approval/decided`），
Host 直接读这两类事件，**不拦截 `approval/request` 瀑布**（拦截会碰到审批链路，风险高）。

- 有待审批项时：气泡变成琥珀色卡片，标题「需要你审批」，下面一行是工具 + 原因
  （多个待处理会显示「还有 N 项待处理」）；如果收起，卡片就是弹窗本身。
- 鱼右上角挂一个 **「!」琥珀色角标**（不再套光环/圆圈，鱼是直接贴在桌面上的）。
- 展开时会在面板顶部插入一块「等待你审批」的提示区，进度条暂时让位给轮次/步数信息。
- **点这张卡片 = 把 DSH 窗口提到最前**，直接去点「允许/拒绝」，不用自己找窗口。
- 新审批出现时播一次系统提示音；右键菜单里的「审批提示音」可以关掉
  （持久化在 `widget.json` 的 `alertSound`）。
- **审批有结果时会闪 6 秒确认**：`approval/decided` 的 `outcome` 映射成
  「已允许 / 已拒绝 / 已取消 / 审批未完成」，面板标题和气泡变对应颜色，鱼上角标换成
  ✓ / ✗ / —，这样你能知道刚才那一下点的是允许还是拒绝。
- 卡片、角标随即消失；回合结束或 DSH 停止写入时也会自动清掉，不会留一个假的「等你审批」。

## 安装

**环境要求**：Windows 10/11 + [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。挂件是 PowerShell + WinForms 写的，系统自带，无需管理员权限；不联网、不上传任何数据。

### 方式一：dsh 命令安装（推荐）

```powershell
dsh plugin --profile desktop add github:oioiphainon/dsh-widget
```

- `--profile desktop` 换成你实际用的 profile 名（不确定就先 `dsh profile list` 看一眼）。
- 装完 DSH 会自动加载插件并在 1.5 秒内拉起挂件，桌面右下角出现一条工鱼；DSH 重启后也会自动拉起（挂件自带单实例互斥锁，不会叠出两只鱼）。
- 想固定到最新版，可钉住 tag：`dsh plugin --profile desktop add github:oioiphainon/dsh-widget#v0.4.2`。

### 方式二：插件市场（收录审核中）

DSH 里装了 `dshmarket`（可视化插件市场）的话，等本仓库通过 awesome-dsh-plugin 收录后，直接在市场里搜「桌面工鱼 / desk fish / dsh-widget」一键安装。

### 方式三：本地目录（开发 / 离线）

```powershell
git clone https://github.com/oioiphainon/dsh-widget.git
# 或者直接下载 zip 解压
dsh plugin --profile desktop add D:\path\to\dsh-widget
```

也可以用当前 profile 的 `plugin_manager` 工具安装本目录（`install_bundle`，target 为目录绝对路径），效果相同。

### 验证 & 卸载

- **装好了吗**：桌面右下角出现鱼 + 气泡；任务栏托盘（可能在「^」溢出面板里）多了一条小鱼图标。
- **手动拉起 / 找回**：双击插件目录下的 `desktop\launch-widget.vbs`。
- **卸载**：`dsh plugin --profile desktop remove @local/dsh-fat-fish-widget`（或装法对应的包名），再右键鱼 → 退出即可；配置留在 `%LOCALAPPDATA%\dsh-fat-fish`，想清干净就一并删掉。

> 为什么拉起要走 `desktop\launch-widget.vbs`（`wscript` → `WScript.Shell.Run`）而不是直接
> `spawn`：Windows 上直接创建的子进程会留在 Host 的作业对象/沙箱里，Host 退出时被一起带走；
> 经 ShellExecute 启动的进程归外壳所有，才能真的留在桌面上。这也是挂件能活过 DSH 关闭的
> 关键一环。

## 排查

- 鱼外面有白圈/白色方块：0.3.1 修。素材换成透明 PNG（`desktop/fish.png`），画布不再画
  白色圆盘、描边和投影，鱼直接贴在桌面上；审批提醒改用右上角角标（`!` / ✓ / ✗），不再套
  光环。
- 进度「有延迟」：0.4.0 再收紧。回合边界事件（`turn/start` / `turn/end` /
  `user/message` / agent 状态）**零延迟写快照**，普通事件合并窗口 60 ms，挂件轮询
  100 ms，事件到显示 ≈ **60 ms（写盘）+ 100 ms（读盘）+ ≤120 ms（绘制）≈ 0.2–0.3 s**。
  「完成」徽标 10 秒后回落到「摸鱼中…」；一轮进行中追加的消息会被记住，回合结束立刻
  显示「排队中…」，不会卡在上一轮的「完成」。
- 鱼不见了：可能是在右键菜单里点了「隐藏悬浮窗」——**点系统托盘里的小鱼图标**即可恢复。
  进程真的没了的话，双击 `desktop\launch-widget.vbs` 重新拉起；想确认进程是否还在，
  看托盘小鱼是否亮着，或找 `powershell.exe`（窗口标题 `FatFishDesktop`，无任务栏按钮）。
- 显示「DSH 未运行」：Host 超过 7 秒没写 `state.json`，通常是 DSH 关了或在重启；
  DSH 起来后 1 秒内自动恢复。
- 想彻底停掉：右键鱼 → 退出；若开了开机自启，记得把右键菜单里的「开机自启」勾掉
  （或直接删启动文件夹里的 `FatFishDesktop.lnk`）。
- 遗留 `state.json.*.tmp`：旧版本读写争用会留下临时文件；0.2.0 起挂件用共享方式读文件、
  Host 写失败会自己清理，正常不会再出现（可用 `Remove-Item` 手动清一次）。
- 拖动时抖动/闪烁：0.2.1 已修。拖动位移改为锚定**屏幕坐标**（客户端坐标会随窗口移动而
  自我抵消，表现为拖一半、来回抖），移动只走一次 `SetWindowPos`（不再分别改 Left/Top、
  也不再让渲染循环顺手挪窗），拖动期间暂停重绘，展开/收起时尺寸和位置一次性设置，并禁用
  了 WinForms 自身的 `OnPaint`/`OnPaintBackground`（窗口内容只由分层的
  `UpdateLayeredWindow` 提供，否则移动/改尺寸时会闪一下底色的白块）。

## 开发

```powershell
# 只渲染预览图（浅色/深色 × 气泡/面板），不弹窗：
powershell.exe -ExecutionPolicy Bypass -File desktop\FatFishDesktop.ps1 -SelfTest <输出目录>

# 指定状态文件与配置目录（调试用，不碰 %LOCALAPPDATA%）：
powershell.exe -ExecutionPolicy Bypass -File desktop\FatFishDesktop.ps1 `
  -StatePath .\state.json -DataDir .\fishdata
```

注意：`FatFishDesktop.ps1` 必须保持 **纯 ASCII**（中文全在 `strings.json`），否则
Windows PowerShell 5.1 会按 ANSI 解码导致乱码；`strings.json` 则以 UTF-8 显式读取。

诊断时间线（事件 → 写盘 → 挂件读盘）可以打开 Host 侧的调试记录：在
`%LOCALAPPDATA%\dsh-fat-fish\` 放一个空文件 `debug-on`，插件的每个会话事件和每次快照
发布都会追加到同目录 `debug.log`；删掉 `debug-on` 即停止（默认不写任何日志）。

## 已知边界

- 只支持 **Windows**（WinForms + 分层窗口 API）；其它平台不启动挂件。
- 挂件是置顶窗口，会盖住全屏游戏/全屏视频；需要时可右键退出或临时收起。
- 进度读的是「最近活跃的会话」：多个会话同时跑时，面板会提示另有几个在跑，但只详细
  展示最活跃那个。
- 挂件本身不联网、不读会话日志，只读本机那个 `state.json`。

## 更新记录

- **README 安装一节重写**：补上 `dsh plugin add github:oioiphainon/dsh-widget` 一行装法、
  插件市场（收录审核中）、本地/离线安装、验证与卸载；顶部简介加快速安装指引。此前只写了
  本地开发目录装法，GitHub 访客不知道怎么装。
- **0.4.2**：系统托盘图标——隐藏后一键找回。
  - 挂件常驻 Windows 系统托盘（小鱼图标，取自 `fish.png`）：**左键点击 = 显示/隐藏切换**，
    隐藏时悬停提示「桌面工鱼已隐藏 - 左键点击恢复」；右键 = 与气泡相同的完整菜单。
  - 此前隐藏后只能靠再跑一次 `launch-widget.vbs`（或重开 DSH）恢复，入口太隐蔽——
    0.4.1 的「隐藏」实际上藏得找不回来；托盘图标让它真正可用。
  - 菜单项在隐藏状态下自动变为「显示悬浮窗」（同一项切换）。
  - 悬停 tooltip 与气泡状态同步（轮次进度/摸鱼中/DSH 未运行等）。
  - 进程退出时托盘图标自动清理，不留幽灵图标。
- **0.4.1**：隐藏悬浮窗 + 位置防丢。
  - 右键菜单新增「隐藏悬浮窗」：整只鱼（气泡 + 鱼）从桌面消失，进程留在后台继续轮询，
    隐藏期间不播放审批提示音，也不再重绘（省电）。
  - 恢复：再启动一次 `desktop\launch-widget.vbs`（或重新打开 DSH / 重载插件）。第二次
    启动拿不到单实例锁，会写一个 `show-request` 请正在运行的挂件现身，随即回到桌面。
  - 隐藏是运行期状态，不写进 `widget.json`——避免下次登录看不见鱼还以为坏了。
  - **位置防丢**：`widget.json` 里的 x/y 现在启动时和保存前都会被钳到虚拟屏幕内（至少留
    60 px 可点区域），展开/收起时也按整个桌面而不是只看主屏。以前保存的坐标可能落在
    屏幕外（换分辨率、拔掉副屏、被拖到角落），挂件就真的「消失」且无法右键找回；现在
    会自动拉回来。
- **0.4.0**：两个开关 + 进度更跟手。
  - 右键菜单新增「开机自启」：默认关闭，打勾即在启动文件夹放
    `FatFishDesktop.lnk`（指向 `launch-widget.vbs`），取消即删除；快捷方式存在与否
    就是唯一的开关状态。
  - 右键菜单新增「DSH 退出后保留悬浮窗」：默认打开；关掉后挂件在 Host 停止写快照
    约 30 秒后自己退出，适合「只在用 DSH 时出现」。选择持久化到 `widget.json`。
  - 延迟修复：回合边界（`turn/start`、`turn/end`、`user/message`、agent 状态）改为
    **零延迟写快照**，普通事件合并窗口 120 ms → 60 ms，挂件轮询 180 ms → 100 ms；
    「完成」徽标不再永久挂着（回合结束 10 秒后回落到「摸鱼中…」）；用户在一轮进行中
    追加的消息会被记住，回合一结束就显示「排队中…」而不是上一轮的「完成」。
- **0.3.3**：取消开机自启——删除 `desktop/install-autostart.ps1` 与
  `desktop/uninstall-autostart.ps1`，删掉启动文件夹里的 `FatFishDesktop.lnk`。
  挂件改为**只在打开 DSH、Host 加载插件时自动拉起**（加载后 1.5 秒内）；
  关掉 DSH 鱼仍留在桌面上，下次开 DSH 会复用同一只（单实例互斥）。
- **0.3.2**：整体放大一圈——新增全局缩放 `$script:UiScale`（默认 `1.12`），
  卡片、鱼、文字等比放大 12%（收起气泡 465×303 → 521×339）。开源到 GitHub。
- **0.3.1**：去掉大肥鱼外面的白色圆圈/描边/投影，素材换成透明 PNG，鱼直接贴在桌面
  上；审批提示改用右上角角标（`!` / ✓ / ✗），不再套光环。
- **0.3.0**：审批提醒——有待审批项时气泡变琥珀色「需要你审批」，点卡片把 DSH 窗口
  提到最前，新审批响提示音；审批有结果后闪 6 秒「已允许 / 已拒绝 / 已取消」确认。
- **0.2.2**：进度延迟优化——Host 每个会话事件后 120 ms 内补写快照，挂件轮询降到
  180 ms，事件到显示 ≈ 0.3–0.4 s；用户发消息立刻切「排队中」。
- **0.2.1**：修拖动时闪烁——拖动锚定屏幕坐标、移动合并为一次 `SetWindowPos`、禁用
  WinForms 自绘，拖动期间暂停重绘。
- **0.2.0**：`state.json` 原子写 + 挂件共享读，消灭遗留 `*.tmp` 与读取冲突。
- **0.1.0**：第一版桌面挂件：独立 WinForms 分层窗口，关掉 DSH 也留在桌面上。
