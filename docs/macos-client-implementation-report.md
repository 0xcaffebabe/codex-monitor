# macOS client 实现与验收报告

> 2026-11-16 后续已将新会话默认权限改为完全访问，并补充受限模式网页审批，详见 [会话权限与审批更新](macos-permissions.md)。本报告保留先前一轮验收结果。

验收时间：2026-11-15 至 2026-11-16。代码基线为 `4b1ff95238d5037e87396e43ca3243d8ceee4448`，本次实现保留为工作区改动。安装与日常使用见 [macOS client](macos-client.md)。之前两份测试报告记录的是修改前状态，不能据此判断当前后端仍依赖 tools 转发。

## 交付结果

普通 Node 可以独立承载 macOS client，通过桌面包自带 CLI 和原 owner IPC 完成控制，不再要求签名 Node、Codex 父进程或私有 tools 转发。没有修改桌面签名、鉴权、沙箱或原有 Codex 配置。

- 新增 `MacDesktopControl`：读取原生项目和模型，创建带项目 ID 的会话；已加载会话交给原 owner，只有明确没有 owner 时才 resume。结果不确定时保留回执，不换通道重发。
- 每个自有执行会话使用独立 CLI 进程。活动目标保留进程供核心自动续跑；空闲后退出该进程释放 writer，让桌面能够接手。元数据进程独立存在。
- 目标写入使用持有 writer 的运行时；停止核对 turnId、目标身份和暂停后的状态；压缩立即阻挡后续输入，由已有持久队列投递。
- 自动发现 `/Applications`、`~/Applications` 下实际包含 CLI 的 Codex.app / ChatGPT.app；支持显式覆盖。macOS watchdog 已接入后台启动和重试逻辑。
- 新增 `start.sh`、`stop.sh` 及后台启动器：发现 Node 24+，解析 `.env` 而不执行 Shell 内容，记录日志，按 PID、UID、启动时间和完整命令核对进程后停止。
- 新增持久的 `created` 会话范围及新建项目目录限制。历史、用量、图片、通知和控制入口共同执行范围检查。
- 修复 node-pty 官方 macOS spawn-helper 缺少 owner 执行位的问题；后台缺少 locale 时为 macOS PTY 设置 UTF-8，修复 zsh 中文回显。

## 实机与部署

| 项目 | 实际值 |
| --- | --- |
| 系统 | macOS 27.0.1，arm64，同一登录用户，非 Rosetta |
| Node | 生产与全量回归 26.12.1；client 相关兼容回归 24.13.0 |
| 桌面 | `/Applications/ChatGPT.app`，26.1111.21308，build 27194 |
| CLI | 包内 Codex CLI 0.169.0-alpha.11.1 |
| 部署 | 独立后台 client，父进程为 launchd；干净环境启动，不继承 Codex 工具变量 |
| 线上工作空间 | `cjp-macOS`，`5f3cf1a0-0c7e-4039-a69e-552f3f641722` |
| 测试范围 | 当前项目下本 client 新建的 4 个会话；其他本机历史不对该工作空间开放 |

线上地址：[已完成的两轮目标与压缩测试会话](http://159.75.6.20:14317/?workspace=5f3cf1a0-0c7e-4039-a69e-552f3f641722&session=01a1dfbe-bae3-74b1-b736-97b4c3f849b9)。账号凭据与工作空间密钥未写入仓库。

本机私有数据位于 `~/.config/codex-monitor/macos`。已有 `start-client.sh` 保存当前连接参数并引用私有密钥文件，执行该脚本可恢复本次连接；停止命令为：

```bash
./stop.sh --data-dir "$HOME/.config/codex-monitor/macos"
```

## 真实线上链路

浏览器使用本机 Chrome 的独立测试标签页，连接用户指定 Server。以下控制使用真实 CLI、模型和会话；fixture 浏览器回归另列。

| 验收项 | 结果与依据 |
| --- | --- |
| 连接与资源 | 工作空间在线，实时记录与整机资源可读；独立后台重启后恢复同一工作空间 |
| 新建与模型 | 从页面选择当前项目、GPT-6.1-Sol / low，真实新建并收到唯一回复；原生项目 ID 与 cwd 持久保存 |
| 空闲发送 | 页面成功继续已有会话，实际历史中出现一次指定回复 |
| 同轮追加 | 等待命令运行时发送，回执 `mode=append`；投递前后同一 turn `01a1df79-7a6c-7c43-955d-fc9d9734379a`，最终两个标记都出现一次 |
| 附件 | 页面上传带随机 UUID 的文本文件；提示没有包含文件内容，模型经真实附件路径读出并回复该值 |
| 目标设置、暂停、继续、清除 | API 回执和随后实际读取一致；页面能显示原生目标状态 |
| 两轮持续目标 | 最终创建回执 `goalState=saved`；两次不同 turn 分别输出 STEP1、STEP2，原生目标状态为 `complete` |
| 恢复后立即停止 | 约 410 ms 后提交停止；指定 turn 被中断，目标确认 `paused`；原 request ID 重放返回原成功回执 |
| 页面停止 | 点击真实停止按钮后指定 turn 为 interrupted；停止不会承诺终止执行器先前启动的所有后台 Shell |
| 压缩与排队 | 页面可见两次“会话上下文已压缩”；并发提交时消息先返回 HTTP 202 / queued，压缩后成功投递，唯一回复 `MAC_COMPACT_QUEUE_OK_07` |
| 真实项目终端 | Chrome 中打开 zsh，确认项目 cwd、Darwin、持久交互与中文；干净后台环境的 `LANG=en_US.UTF-8`，中文输入回显和输出均正确 |
| 终端回收 | 页面关闭终端后，记录的 worker / Shell 两个 PID 均已退出；API 回归另覆盖权限撤销及子进程回收 |
| 用量与范围 | 最终页面及 HTTP 均为 4 个会话、70 条请求；每条 sessionId 均在范围中；指定原工作会话的用量为 0，详情 HTTP 404 |
| 收尾 | 四个会话均未运行，持久 pending / queued 为 0；早期失败目标已清除，已完成目标保留作证据 |

关键请求：最终目标新建 `14d991a9-dce0-4c5e-8d27-e10cb0e53055`；停止 `142345ec-f600-4fc1-a13e-2a47c9358766`；压缩 `598605db-bfb0-4b06-87b5-28060b6e4156`；压缩期间消息 `6bec5906-386f-4b78-a760-8cf4faf8573c`。

CLI 与桌面互操作另在本地会话 `01a1df9e-de12-77a3-8dfa-8bdd77362fda` 验证：CLI 轮次完成后，其专用进程退出码为 0、运行时映射清空；桌面随后实际发送并读回 `MAC_DESKTOP_TAKEOVER_OK_05`。CLI 新会话能被 Monitor 扫描，桌面列表和读取接口也能找到。旧版桌面侧栏仍可能使用旧项目缓存，需要手动归入项目。

## 发现的问题与修正

1. 单纯 `thread/unsubscribe` 不能可靠释放当前 CLI 的 writer。改为每会话独立进程，并在无活动目标、轮次结束时退出；实机桌面接手已通过。
2. 目标由元数据进程写入会遇到 writer 冲突。改为持有会话的运行时写入；目标保存回执与自动两轮完成均已验证。
3. 当前 CLI 显式传 `origin=user` 会在目标后续 HTTP 轮次产生缺少 call_id 的 function_call_output。恢复省略 origin，由真实用户消息承载目标指令；最终两轮目标完整通过。早期失败会话历史保留，没有将旧失败回执改写成成功。
4. 首次真实 PTY 因包内 spawn-helper 无执行位失败；安装脚本只补 owner 执行位。干净后台环境缺少 locale 导致 zsh 中文输入回显损坏，现由 worker 补 UTF-8。
5. 测试用 `created` 范围最初只限制历史索引，漏掉原生用量扫描，线上用量页曾出现范围外的会话 ID、模型、时间和 token 统计。发现后立即断开 client；现同时限制文件发现、解析记录、SQL 查询和模型列表，旧缓存首次查询也执行范围过滤。实际旧缓存含 298 个会话，修正后首次查询即只有 4 个；同步后缓存也只剩允许的 4 个会话，再恢复连接。已增加旧缓存和原生记录回归。
6. 终端测试曾仅等待 PID 文件存在，可能把尚未写入的空内容转换为 PID 0。现等待有效 PID，避免把进程组存活误判为 Shell 未退出。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 完整构建 | TypeScript、Vite、server 与 terminal-worker 构建通过 |
| Node 26 全量单测 | 157 项，156 通过、1 个 Windows 专用测试跳过、0 失败 |
| Node 24 client 回归 | 启动、CLI、传输、Mac 控制、原生生命周期等一组 34/34 通过 |
| Node 24 最终范围与终端回归 | Mac 控制、会话范围、用量、真实 PTY 合计 29/29 通过 |
| Chromium desktop/mobile fixture | 终端 6/6；新建目标、附件与回执恢复 10/10，分别使用新 Server 避免登录限流 |

Node 24 全仓库仍有已在修改前复现的 gateway 测试结束后异步 EPIPE，不能宣称其全量通过。终端测试已修正 POSIX 引号、zsh 提示符和 PID 文件竞态；资源回归增加断线完成等待及失败路径清理。

日志和探针位于本机私有目录 `/private/tmp/cm-macos-impl`，其中认证文件包含凭据，不能整目录共享。可单独核查的证据包括：

- `all-tests-complete.log`、`node24-scope-verified.log`、`node24-client-tests.log`、`build-final.log`。
- `e2e-terminal-tests.log`、`e2e-goal-tests.log`。
- `native-loop-verified.json`、`online-stop-proof.json`、`online-compaction-queue-proof.json`、`append-proof.json`。
- `per-thread-release-proof.json`、`live-terminal-close-proof.json`、`usage-scope-live-offline-proof.json`、`usage-scope-online-proof.json`。

## 兼容边界与未测项

- 原生交互审批、elicitation 尚无网页答复入口；明确返回不支持错误，不自动批准权限。
- 停止模型轮次可能保留执行器已启动的后台 Shell；本次可控等待进程均已释放。项目终端的关闭会回收其自身进程树。
- macOS 自动发现与 watchdog 已实现，真实运行中的应用检查通过；未重启用户正在使用的桌面，未验证桌面升级、多实例切换及睡眠唤醒。
- 提供可手动后台启停的脚本；未安装登录自启 LaunchAgent，未覆盖退出登录后再登录。
- 实机仅为 Apple Silicon。Intel / Rosetta 未验收。
- 通知上报、去重、设备权限与完成事件由全量隔离回归覆盖；未向真实外部通知接收人发送消息，未把 OS 原生通知弹窗列为实机通过。
- 依赖当前 CLI 的实验性项目、目标和 owner 协议；桌面升级后需要重新验收。
