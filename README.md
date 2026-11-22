# ScreenPower for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/screenpower-dsh.svg)](https://www.npmjs.com/package/screenpower-dsh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-informational.svg)](https://learn.microsoft.com/windows)

> 一键黑屏 / 睡觉模式 / 定时亮屏，深度集成进 DeepSeek Harness：左侧栏「快捷黑屏」面板 + MCP 连接器下的 4 个黑屏工具。

关闭屏幕但**电脑照常运行**（不睡眠、不休眠），支持**按任意键或点击鼠标唤醒**，并可设定每天早上自动亮屏。适用于 Windows 10 / 11。

---

## 一、这是什么

本包把 Windows 原生黑屏工具 ScreenPower 接入 DeepSeek Harness（DSH），包含两部分：

| 部分 | 位置 | 作用 |
|---|---|---|
| **UI 插件** | `packages/ui` | 左侧栏新增「快捷黑屏」入口，点开是一个配置面板：3 种黑屏方式 + 自动亮屏时间 + 状态显示 |
| **MCP 连接器** | `packages/mcp` | 注册 `mcp__screenpower__*` 4 个工具，让 AI 助手也能帮你黑屏 / 亮屏 / 查状态 |
| **原生工具** | `vendor/screenpower` | Windows 上真正干活的 `ScreenPower.exe` 及安装 / 卸载脚本 |

三部分共享同一套 CLI 逻辑，界面操作和 AI 调用看到的状态始终一致。

---

## 二、一键安装

### 第 1 步：安装原生工具（需管理员）

> **给其他使用者的最短路径**（不想读下面也行，就这三行）：
>
> ```powershell
> npm install -g screenpower-dsh          # 装 MCP server + 安装脚本
> screenpower-dsh-install                # 装原生工具（会弹 UAC）
> ```
>
> 然后在 DSH 里：① 插件管理装 UI bundle（见第 2 步）② 「MCP 连接器」新增 stdio 连接，命令 `screenpower-mcp`，参数留空。

**方式 A —— 从 npm（推荐）**

```powershell
npm install -g screenpower-dsh
screenpower-dsh-install
```

**方式 B —— 从 GitHub 源码**

```powershell
git clone https://github.com/JagDuan/screenpower-dsh.git
cd screenpower-dsh
node scripts/install.mjs
```

两条路径执行的都是同一套逻辑，它会：

1. 把 `ScreenPower.exe` 等文件安装到 `%ProgramData%\ScreenPower`（可用 `--install-dir` 指定其他目录）；
2. 运行 `install.ps1` 注册 3 个计划任务并建好桌面快捷方式；
3. 打印出 DSH 集成所需的全部路径配置。

可选参数：

```powershell
# 改时间：00:30 黑屏、06:30 亮屏
node scripts/install.mjs --wake 06:30 --sleep 00:30

# 不要每晚定时黑屏，只保留手动
node scripts/install.mjs --sleep ""

# 只打印 DSH 配置，不安装原生工具
node scripts/install.mjs --skip-native
```

> 脚本可重复运行。若弹出 UAC 请允许；`install.ps1` 需要管理员权限来改电源设置和注册计划任务。

### 第 2 步：安装 UI 插件

安装后左侧栏会出现「快捷黑屏」入口。用 DSH 的插件管理把 `packages/ui` 目录作为本地 bundle 安装即可（从 npm 装的话，路径是 npm 全局目录下的 `node_modules/screenpower-dsh/packages/ui`；安装脚本会打印完整路径）。面板支持：

- **定时黑屏**：立刻黑屏，到设定时间（默认 07:00）自动亮屏；
- **手动黑屏**：立刻黑屏，按任意键 / 点击鼠标才亮屏；
- **仅防休眠**：屏幕保持正常，只阻止电脑睡眠（配合你自己的熄屏方式）；
- 实时状态、连接指示、操作二次确认、中文 / 英文界面。

### 第 3 步：添加 MCP 连接器

在 DSH 的「MCP 连接器」中新增一个 **stdio** 连接：

- 命令：`screenpower-mcp`（已通过 `npm i -g` 安装时可直接用这个短命令）
- 参数：留空

或者用绝对路径（安装脚本会打印）：

- 命令：`node`（写你实际的 node 绝对路径）
- 参数：`<安装目录>/packages/mcp/server.js`

连接成功后会出现 4 个工具：

| 工具 | 作用 |
|---|---|
| `mcp__screenpower__screenpower_status` | 查询当前是否黑屏、何时自动亮屏 |
| `mcp__screenpower__screenpower_blackout` | 黑屏（可带 `until` 定时） |
| `mcp__screenpower__screenpower_wake` | 立即亮屏并还原电源设置 |
| `mcp__screenpower__screenpower_modes` | 列出所有黑屏方式 |

之后就可以直接用自然语言让助手操作，例如「帮我黑屏，明早 7 点亮」「现在把屏幕点亮」。

---

## 三、为什么能「按任意键唤醒」

ScreenPower 的黑屏是真的让内屏**断电**（`SC_MONITORPOWER / OFF`），这比涂黑画面更彻底、更省电。但屏幕断电后，键盘鼠标事件不会被系统转发给显示面板，所以系统自带的「关闭显示器」「调亮度」方式黑屏后按键是唤不醒的。

ScreenPower 用**低级键盘 / 鼠标钩子**在断电前就捕获输入，再由程序主动发 `SCREEN_ON` 把面板重新点亮——这就是「任意键唤醒」能生效的原因。也支持快捷键 `Ctrl + Alt + F12` 手动唤醒。

---

## 四、目录结构

```
screenpower-dsh/
├── packages/
│   ├── ui/                 # DSH UI 插件（Host + Client）
│   │   ├── index.js        # Host 半边：agent 工具 + 本地 HTTP bridge + perform()
│   │   ├── client.js       # Client 半边：面板 UI
│   │   ├── cordis.patch.yml
│   │   ├── locale/         # 中文 / 英文文案
│   │   └── docs/           # 详情页 + 预览图
│   └── mcp/                # MCP server（stdio）
│       ├── server.js       # 4 个 mcp__screenpower__* 工具
│       ├── cordis.patch.yml
│       └── ...
├── shared/
│   └── screenpower-core.js # 共享的 CLI 封装 / 状态解析
├── vendor/screenpower/     # 随包附带的 Windows 原生工具
├── scripts/
│   ├── install.mjs         # 一键安装
│   └── smoke-mcp.mjs       # MCP 冒烟测试
└── README.md               # 本文档
```

运行期文件位于 `C:\ProgramData\ScreenPower\`：`screenpower.log`（日志）、`state.txt`（状态）、`guard.pid`（守护进程 PID）。

### 面板与 Host 的通信方式

面板通过 **同源 HTTP 路由** `<DSH 地址>/plugins/screenpower` 调用 Host（例如 `http://127.0.0.1:61671/plugins/screenpower`）。因为和界面同源，所以不存在跨域、端口猜测或主机重启换端口导致「服务未连接」的问题。

Host 同时保留一个独立监听 `127.0.0.1:18765` 的备用桥，作为同源路由不可用时的兜底。两种入口返回的数据完全一致。

---

## 五、命令行（原生工具）

```powershell
ScreenPower.exe off                # 立即黑屏（手动模式）
ScreenPower.exe off --until 07:00  # 黑屏并定时到 07:00 自动亮屏
ScreenPower.exe on                 # 立即亮屏并还原电源设置
ScreenPower.exe status             # 查看状态
ScreenPower.exe help               # 帮助
```

---

## 六、常见问题

**Q: 需要联网吗？**
A: 不需要。所有操作都在本机完成。

**Q: 卸载怎么弄？**
A: 管理员 PowerShell 执行 `vendor\screenpower\uninstall.ps1`，会删除计划任务、快捷方式并还原电源设置。

**Q: 黑屏期间电脑会睡眠吗？**
A: 不会。黑屏期间「睡眠」「休眠」超时都被设为 0（永不），唤醒或卸载时自动还原。电脑会保持满负载运行，请评估耗电。

**Q: 面板显示「服务未连接」？**
A: 点状态栏右侧的「**刷新连接**」按钮即可重新探测。若面板本身是旧版本代码（看不到该按钮），关掉整个界面窗口/标签页后重新打开当前的 DSH 地址即可加载新代码。

**Q: MCP 工具提示「未安装」？**
A: 设置环境变量 `SCREENPOWER_HOME` 指向原生工具安装目录，或重新运行 `scripts/install.mjs`。

**Q: 点「开始黑屏」后屏幕没黑？**
A: 点完等 3 秒。程序有 3 秒启动宽限期，避免把「点黑屏按钮的那一下」误判成唤醒信号。日志里出现
`entering blackout: showing fullscreen overlay` 就说明全屏黑色覆盖层已接管。

**Q: 屏幕能黑但按鼠标又亮了？**
A: 说明宽限期过后又来了一次真实点击 —— 那正是设计行为（任意键/点击即可唤醒）。想睡觉时别碰键鼠，
或用「定时黑屏」到点自动亮屏。

**Q: 支持 macOS / Linux 吗？**
A: 不支持。原生工具是 Windows 专用的（需要 `powercfg`、DDC/CI、Win32 窗口钩子）。

---

---

## 七、开发者

```bash
npm install          # 安装依赖
npm run smoke        # MCP server 冒烟测试
npm run install:harness   # 本机安装（原生工具 + 打印 DSH 配置）
```

源码结构见上面「四、目录结构」。原生工具源码在 `vendor/screenpower/ScreenPower.cs`（C#，`build.ps1` 用 .NET Framework 的 `csc` 编译）。

## 八、许可证

MIT —— 见 [LICENSE](LICENSE)。

*适配 Windows 10/11 · 原生工具需 .NET Framework 4.x*
