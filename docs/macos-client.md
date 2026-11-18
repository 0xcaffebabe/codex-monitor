# macOS client

macOS 使用普通 Node.js 24+ 运行 client，由已安装 Codex 桌面包中的 CLI 提供原生控制。无需用桌面自带的签名 Node 运行 client，也不需要 tools 转发进程。Apple Silicon 真机验证环境为 Node 26.12.1、Codex 26.1111.21308 / CLI 0.169.0-alpha.11.1。

会话控制器现已与 Windows 共用，统一行为及 Windows 验证边界见 [会话控制与审批](native-control.md)。本文中的 macOS 实机验证记录不代表 Windows 实机验收。

## 安装与连接

```bash
npm ci
npm run build

# 在 Server 的“管理工作空间”中创建工作空间，将密钥保存到本机私有文件。
# 以下占位值需替换；密钥文件应只有当前用户可读。
chmod 600 "$HOME/.config/codex-monitor/client.key"

./start.sh \
  --server-url https://monitor.example.com \
  --workspace-id <workspace-id> \
  --client-key-file "$HOME/.config/codex-monitor/client.key" \
  --data-dir "$HOME/.config/codex-monitor/client" \
  --session-scope created \
  --project-path /absolute/path/to/project
```

`start.sh` 启动独立后台进程，关闭 Terminal 后继续运行。重复启动会返回已有进程。默认 Node 版本不足时，启动器会查找 NVM、Homebrew 中的 24+ 版本，也可显式设置 `MONITOR_NODE=/absolute/path/to/node`。启动器将仓库作为工作目录，读取 `.env` 的配置值，已有环境变量和命令行参数优先；不会执行 `.env` 中的 Shell 代码。

```bash
./scripts/macos-client.sh status --data-dir "$HOME/.config/codex-monitor/client"
./stop.sh --data-dir "$HOME/.config/codex-monitor/client"
```

日志为数据目录中的 `client.log`，进程记录与新建会话范围也保存在该目录。停止前会核对 PID、用户、进程启动时间和完整命令，避免终止其他 Node 进程。后台启动不依赖 Codex 的父进程或继承环境。

`npm ci` 的安装脚本会修复 node-pty 官方 macOS 预编译 `spawn-helper` 缺失的 owner 执行位。若曾禁用安装脚本，可手动运行 `node scripts/prepare-native.mjs`。Sharp 和 PTY 继续使用普通 Node 的原生依赖环境。

## 数据范围

`--session-scope created` 只向 Server 展示这个 client 新建的会话。范围持久化到 `session-scope.json`，覆盖列表、详情、搜索、图片、用量、通知和控制入口；损坏时拒绝启动。适合线上验收和专用会话，已有会话即使知道 ID 也无法读取。配合 `--project-path` 可将新建项目选项限制为指定目录。

需要同步已有的本机历史时，使用 `--session-scope all`，这是为已有 client 保留的默认行为。线上管理员将可以访问该 Codex home 中的历史。`--project-path` 限制的是新建项目选择，不替代历史范围设置。

## 控制方式

| 能力           | macOS 实现                                                        |
| -------------- | ----------------------------------------------------------------- |
| 项目与模型     | 原生 `project/list`、`model/list`，支持分页和模型对应的思考级别   |
| 新会话         | `thread/start` 同时保存项目 ID 和 cwd，再发送首条消息             |
| 自动标题       | 首条消息受理后后台概括，通过 `thread/name/set` 保存原生名称       |
| 已加载桌面会话 | 通过 owner IPC 将消息交给原 owner，支持同轮追加                   |
| 未加载会话     | 确认没有 owner 后原生 resume；保留已有会话设置                    |
| 状态           | 不读取完整工具输出；使用元数据、原 owner 确认与本地轮次状态       |
| 目标           | 原生目标 API；真实用户消息承载指令，同一运行时保存、续跑和完成    |
| 停止           | 校验指定 turnId；核对同一目标是否暂停，无法确认时在回执中提示     |
| 压缩           | 原 owner 或原生 compact；压缩期间保留消息队列                     |
| 终端           | 独立 node-pty worker；支持 zsh、中文、窗口调整、Ctrl+C 和关闭回收 |

对已经发出的不确定请求不会切换通道重发。Server/client 的持久 request ID 去重机制保持有效。

每个执行中的自有会话使用独立 CLI 进程。轮次结束且没有活动目标时，client 关闭该进程以释放 writer，桌面随后可以接手；活动目标保留进程，以便原生核心继续执行下一轮。元数据读取使用单独进程，不会占用已释放会话的 writer。

新建会话在首条消息受理后自动生成简短标题，沿用所选模型或本机默认模型，使用模型支持的较低思考级别。生成在独立的临时只读会话中完成，不向原对话插入消息；完成后通过原生名称接口保存，网页侧栏、详情和 Codex 桌面读取同一名称。生成期间先显示首条提问，超时或失败时保留该标题，不影响消息发送。已保存的会话名称不会被覆盖；后续追问不重复生成标题。关闭 client 会取消尚未完成的生成请求。更新后需重新构建并重启 macOS client。

CLI 和桌面使用相同的 `CODEX_HOME`，新会话会被 Monitor 扫描，也可以被桌面的会话列表和读取接口找到。原生项目 ID 会持久保存；部分桌面版本仍使用旧的侧栏项目缓存，因此可能先显示在最近会话中，需要在桌面里移动到对应项目。不要通过直接改写 `.codex-global-state.json` 强行同步缓存。

CLI 从桌面安装包自动发现，支持 `/Applications` 和 `~/Applications` 下实际包含 Codex CLI 的 `Codex.app`、`ChatGPT.app`。非标准位置可配置 `--codex-desktop /path/to/App.app` 或 `--codex-cli /path/to/codex`。桌面 watchdog 使用 `open -gj` 启动缺失应用，已有应用保持后台状态；`--codex-autostart false` 可关闭监测。

`--codex-pipe` 是显式选用旧 tools 通道的诊断选项。正式 macOS 包会鉴权 tools 对端，普通 Node 被拒绝时应使用默认原生通道；不应修改应用签名或关闭鉴权。

## 边界

停止针对当前模型轮次。CLI / 桌面执行器已经启动的后台进程可能继续运行，应在项目终端中管理。client 不会扫描并终止其他会话的进程。项目终端自身的关闭与连接断开会回收它创建的 Shell 和子进程。

从不继承语言环境的后台进程启动 macOS 终端时，worker 默认使用 `en_US.UTF-8`，保证 zsh 的中文输入回显正确；已有 locale 设置保留。

## 会话权限

macOS 上由 Monitor CLI 新建的会话默认沿用目标机器的 Codex 权限；未提供权限字段也沿用本机配置。完全访问需要显式选择。已有会话保持原先设置。

更新后的 Server 页面在“新建会话”中提供权限选择：

| 选项 | 行为 |
| --- | --- |
| 沿用本机配置（默认） | 使用本机 Codex 的沙箱与审批策略 |
| 完全访问 | 取消 Codex 文件与网络沙箱，无逐次审批 |
| 只读 | 只读沙箱；额外权限由网页确认 |
| 项目写入 | 可修改项目，联网等额外操作由网页确认 |
| 项目写入并允许联网 | 可修改项目并联网，其他额外操作由网页确认 |

受限模式支持命令、文件修改和额外权限三类网页审批。“允许本次”只批准当前操作；额外文件和网络权限只授予当前轮次。请求到期、轮次结束或 CLI 退出后失效；重复答复不会再次执行。文件审批会显示文件路径、修改类型、移动目标及差异，差异未就绪时禁止批准。审批会重新核对管理员角色和登录设备。

网页审批适用于 Monitor 自己承载的 CLI 会话；由桌面持有的会话仍在桌面确认。结构化提问与 MCP elicitation 暂无网页答复入口，明确返回不支持。完全访问控制的是 Codex 沙箱和审批策略，操作系统权限及本机强制策略仍由系统执行。认证与模型配置继续使用本机 Codex 配置。

本次权限修复与实机验证见 [macOS 会话权限与审批](macos-permissions.md)。

本机历史与目标使用原生 CLI 的数据格式和实验性 API。升级桌面后应重新运行回归与实机验收；不支持的接口会明确报错，不会退回绕过鉴权的转发。

## 验证

```bash
npm run build
TMPDIR=/private/tmp/codex-monitor-test SHELL=/bin/zsh \
  node --disable-warning=ExperimentalWarning --import tsx \
  --test --test-concurrency=4 tests/*.test.ts
```

先创建上例的短临时目录。macOS 的系统 TMPDIR 可能让 fixture Unix socket 超过路径上限；使用规范化的 `/private/tmp` 路径也避免 `/tmp` 符号链接带来的路径断言差异。

真实线上验收应使用独立工作空间及 `created` 范围，通过浏览器检查新建、模型设置、空闲发送、同轮追加、附件、目标生命周期、停止、压缩、用量、通知和项目终端，并在结束时确认没有活动测试目标、排队消息或遗留终端进程。已完成目标可保留作验收记录。
