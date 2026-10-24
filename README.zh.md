# dsh-relaunch

[English](README.md) | **中文**

从 DeepSeek Harness 自己的侧边栏重启它。

🎯 这个应用没有重启入口。本插件补上一个 —— 而且与直接改应用自身文件不同，它**在应用升级后依然存在**。

> **仅支持 Windows。** 重启依赖 Windows 提供的机制（`wscript.exe` 实现无窗口启动、`taskkill` 终止进程）。在 macOS 和 Linux 上侧栏入口仍会出现，但按下后会明确失败，而不是做出意料之外的事。

## 为什么需要它

DeepSeek Harness 没有提供重启自身的界面。顶栏有一个「应用」菜单，源码里也确实存在重启项 —— 但它被 `development` 标记挡住，正式版永远不会满足条件，因此点不到。

最直接的做法是给应用的 `app.asar` 打补丁。这在第一次升级前都有效：升级程序会把整个归档文件替换掉，补丁随之消失，按钮也就没了。何况直接修改别的程序的安装文件，本身就是一件要永远重做的事。

所以这个插件从外部解决问题。插件装在 DSH 的 profile 里，升级不会碰它；它在侧边栏加一个入口，点开面板里的按钮，Harness 就会被关闭并重新启动。

## 特性

| | |
| --- | --- |
| ⚡ 一键重启 | 侧栏出现一个入口，和其他面板图标并排 |
| 🚫 不闪控制台窗口 | worker 全程无窗口启动，屏幕上不会闪任何东西 |
| 🚫 不弹确认框 | 重启不询问任何东西；面板上那个按钮本身就是确认 |
| 🔁 升级不丢 | 作为 profile 插件安装，不刻进应用本体 |
| 🔒 不会误触 | 重启绝不自动触发，必须按下按钮 |
| 🌐 双语 | 中文与英文，跟随应用的语言设置 |

## 安装

```bash
npm install @yishuiliufang/dsh-relaunch
```

然后加到 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "@yishuiliufang/dsh-relaunch"]
    }
  }
}
```

本包自带 `cordis.patch.yml`，会把插件行插入到进程级组合里。**需要重启一次 profile** —— 加载器只在启动时读取组合，侧栏入口要等重启后才会出现。

## 使用

点左侧栏里的圆形箭头图标，面板中只有一个按钮。

按下后依次发生：

1. 向插件自己的 Host 路由发出请求。
2. 等一小会儿，让响应先回到浏览器。
3. 终止正在运行的 Harness 进程。
4. 重新启动应用，确认它真的活着，并把每一步写进日志。

**所有正在运行的任务都会被打断。** 这本就是重启的含义 —— DSH 会为会话持续做检查点，所以对话记录不会丢，但那一刻正在执行的任务会中断。

## 实现原理

重启无法在插件内部完成，因为插件**就跑在被重启的那个进程里**。如果交给进程内调用，进程会在响应途中把自己杀掉，而它启动的任何子进程也会一起死掉。所以这件事交给一个脱离进程树的 worker：

```
侧栏按钮
  └─ POST /dsh-relaunch/restart          （Host 半边，认证路由）
       └─ wscript.exe launch-hidden.vbs  （GUI 子系统：不分配控制台）
            └─ DeepSeek Harness.exe      （ELECTRON_RUN_AS_NODE=1：Node 模式，无窗口）
                 └─ restart-harness.mjs  （终止 → 等待 → 启动 → 验证）
```

两个细节是关键：

- **用 `wscript.exe` 启动，而不是 `powershell.exe`。** PowerShell 属于*控制台*子系统：启动它会分配一个控制台窗口并在屏幕上闪一下，而用来脱离进程树的 WMI 调用无法请求 `CREATE_NO_WINDOW`。Harness 的可执行文件属于 *GUI* 子系统，以 Node 模式运行它完全不产生窗口。
- **worker 在重启应用前会剥掉 `ELECTRON_RUN_AS_NODE`。** 正是这个变量让 worker 以 Node 而不是桌面应用的方式运行。它是进程级变量，会被继承 —— 而继承了它的 Electron 进程会退化成纯 Node 运行时，没有应用逻辑，一秒内自行退出，最后*什么都不剩*。`test/host.mjs` 专门钉住了这一点。

## 运行要求

- **Windows。**
- DSH desktop `>= 0.1.7-rc.2`（`engines.dsh`）。

本插件**不声明任何 `@deepseek-ai/*` peer 依赖**，也没有导入它们的值。这是刻意的：DSH 启动时会对每个 profile bundle 做兼容性检查，只要有一条 peer 范围覆盖不到当前版本，**整个 bundle 会被跳过** —— `cordis.patch.yml` 不会生效，表现就是「装了但毫无反应」。不写 peer 范围，这种失败就不可能发生。

## 配置

无。插件没有可选项，路由和延迟都是固定的。

## 已知限制

- **仅 Windows**，如上所述。其他系统上侧栏入口会出现，但重启会失败。
- **正在运行的任务会被打断。** 这不是 bug，但值得再说一次。
- **需要重启一次 profile 才会出现。** 在 Harness 运行时安装只会把包链接进 profile，侧栏要等应用重启后才显示入口。
- **同一时刻只应有一个重启在进行。** 按钮在重启期间会自行禁用，但没有机制阻止另一个窗口也去按它。

## 项目结构

```
dsh-relaunch
├── index.js            # Host 半边：注册重启路由
├── client.js           # 客户端半边：侧栏入口与面板
├── restart-harness.mjs # 脱离进程树的 worker：终止、等待、重启、验证
├── launch-hidden.vbs   # 无窗口启动器（wscript → Node 模式）
├── restart-harness.ps1 # 过渡 shim，缘由见 CHANGELOG
├── locale/             # 插件列表元信息（en、zh）
├── icon.svg            # 插件列表图标
├── test/
│   ├── manifest.mjs    # 包与清单接线（16 项）
│   ├── host.mjs        # 路由契约与重启环境（11 项）
│   └── client.mjs      # 客户端挂载、本地化、面板状态（17 项）
├── cordis.patch.yml    # Bundle 层：插入插件行
├── dsh-plugin.json     # 插件清单
├── CHANGELOG.md        # 版本说明
└── package.json
```

## 测试

```bash
npm test
```

不需要 DSH host，也不需要任何依赖 —— 测试只导入 Node 内置模块。`host.mjs` 覆盖了上文那个环境变量泄漏问题，它是本项目里唯一一个「比不装插件更糟」的 bug。

## 更新记录

每个版本的改动见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
