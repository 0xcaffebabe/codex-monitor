# Windows / macOS 会话控制与审批

Windows 和 macOS 默认共用 `NativeDesktopControl`，通过本机 Codex CLI 的 `app-server --listen stdio://` 创建、恢复和执行会话。两端使用相同的权限选择、网页审批和运行时生命周期；不需要单独安装 Codex SDK。

## 新会话与权限

在网页新建会话时可以选择以下权限；默认值与原 macOS client 一致。

| 选项 | 行为 |
| --- | --- |
| 完全访问（默认） | `danger-full-access` / `never`，无逐次命令审批 |
| 沿用本机配置 | 保留本机 Codex 的沙箱与审批配置 |
| 只读 | 只读沙箱，额外权限交给用户审批 |
| 项目写入 | 允许修改项目，联网等额外权限交给用户审批 |
| 项目写入并允许联网 | 允许修改项目和联网，其他额外权限交给用户审批 |

权限选项只用于新会话；恢复已有会话保留其设置。受限模式将审批交给用户，不自动批准。操作系统权限及本机强制策略仍然有效。

## 网页审批范围

Monitor 自己承载的 App Server 会话支持命令执行、文件修改、额外文件系统与网络权限三类审批。文件审批展示路径与差异；差异未就绪时不能批准。“允许本次”只批准当前操作，额外权限仅本轮有效。

审批使用原始 App Server 请求 ID 和原进程回调答复。同名请求 ID 在不同会话中分别处理；断线、轮次结束或请求已被解决时取消等待，旧审批不能在替代进程上重放。网页读取与答复继续验证管理员、登录设备、工作空间和会话范围。

由 Codex 桌面持有的会话通过 owner IPC 转发消息、停止与压缩，审批仍在桌面处理。结构化提问与 MCP elicitation 尚无网页答复入口。

## CLI 与旧通道

`MONITOR_CODEX_CLI` / `--codex-cli` 可指定 Codex CLI；也支持桌面运行环境的 `CODEX_APP_RUNTIME_CLI_PATH`。Windows 自动检查指定桌面程序旁的 `resources/codex.exe`、已有 `OpenAI/Codex/bin` 运行时缓存、常见独立安装目录和可读取的 Windows Store 安装目录。找不到时明确提示配置 CLI 路径，不会将桌面 GUI 当作 CLI 启动。

macOS 沿用桌面 `.app` 内 CLI 自动发现。两端都沿用当前用户的 Codex 配置与登录，`CODEX_HOME` 控制读取及执行的数据目录。

显式设置 `MONITOR_CODEX_PIPE` / `--codex-pipe` 会使用旧的桌面 tools 通道，保留原行为，不提供新的权限选择与网页审批。要使用统一通道，应移除此显式设置并重启 client。其他操作系统继续保留原桌面桥接行为。

更新后重新构建并重启 Server 和对应 client，网页权限控件和 client 审批回调需同时更新。后台启动器会按已有进程身份核验规则加载新构建；本次代码修改不直接重启正在运行的服务。

## 验证边界

自动测试覆盖 Windows/macOS 默认控制器选择、显式旧 pipe、Windows CLI 安装路径发现、真实 JSON-RPC 帧的审批等待与答复、文件差异、跨会话隔离、断线取消，以及原桌面 owner 的转发和不确定回执处理。Windows 路径查找使用临时目录中的模拟安装，不运行其中的可执行文件。

2026-11-16 在 macOS 完成构建、201 项后端测试（普通 Node 26.12.1；1 项 Windows 专用检查跳过），以及桌面和手机端 10 项审批、12 项新建与目标浏览器测试。审批和旧 client 兼容测试分别使用各自的独立 fixture 服务。

运行环境记录：Node 24.13.0 的全量测试在上传用例结束后报告 `EPIPE`；应用内置 Node 24.22.1 的 PTY 等原生依赖测试失败。普通 Node 26.12.1 下全量测试通过，与既有 macOS client 的验证环境一致。

Windows 系统沙箱、Store 目录访问权限及当前桌面版本的 owner IPC 兼容性仍需在 Windows 实机验证；macOS 上通过模拟服务的测试不等同于 Windows 实机验收。
