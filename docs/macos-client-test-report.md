# macOS client 实机测试报告

> 本报告对应首轮快照 `75c9750`。用户授权后的完整控制复测、新快照 `72c1329`、临时转发实验及未通过项见 [完整桌面控制复测报告](macos-desktop-control-test-report.md)。

测试日期：2026-11-15（Asia/Shanghai）。依据 `docs/macos-client-handoff.md`，在当前 Mac 上验证安装、真实数据、桌面 tools、CLI、owner IPC、Server/client 与浏览器回归。

**结论：此 checkout 的只读 client 链路可用；完整桌面控制被当前安装桌面的 tools 进程鉴权阻断。** 普通 Terminal 和 agent 启动的 Node 均未取得成功的 tools RPC 回执。独立的 CLI 目标读写、owner 停止和压缩已实机通过，但 Monitor 的控制接口还需先调用 tools 查询状态，因此不能据此认定网页控制可用。

**环境与快照**

| 项目         | 实测值                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 代码         | `75c97500fe49b6a84a9df1613226c57a72220786`；测试开始时工作区干净                                                                         |
| 系统         | macOS 27.0.1 / build 26A434；Apple Silicon / arm64；Rosetta 标志为 0；UID 501                                                            |
| 原默认运行时 | Node v22.14.0，低于项目声明的 24+；未用于验收                                                                                            |
| 主要运行时   | `$HOME/.nvm/versions/node/v24.13.0/bin/node`，arm64；npm 11.6.2                                                                          |
| 对照运行时   | `$HOME/.nvm/versions/node/v26.12.1/bin/node`，arm64                                                                                      |
| 桌面         | `/Applications/ChatGPT.app`，实际 bundle ID 为 `com.openai.codex`，版本 26.1111.21308，build 27194；渠道未独立核实                       |
| CLI          | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`；0.169.0-alpha.11.1                           |
| Node 24 签名 | Developer ID Application: Node.js Foundation；TeamIdentifier `HX7739G8FX`                                                                |
| 数据与通信   | 原用户 `~/.codex`；显式 tools socket 为 `/tmp/codex-app-tools/<instance>.sock`，62 字节、UID 501、0600；owner 为 `~/.codex/ipc/ipc.sock` |
| 专用测试会话 | 当前 `codex-monitor` 项目中的“macOS Monitor 兼容性测试”，ID `01a1dee5-ce85-7433-91ca-7673627f196c`                                       |
| Server       | 隔离 loopback Server、独立工作空间与私有数据目录；真实构建后的 `dist/server.mjs --mode client` 主动连接                                  |
| 依赖差异     | 当前 package/lockfile 没有 node-pty、sharp；没有项目终端实现、terminal worker 或 terminal 测试。交接文档中的这部分不能用于本快照验收     |

私有证据目录为 `$HOME/codex-monitor-macos-handoff.hTqPj6`，下文记为 `$MAC_TEST_OUT`。仓库变更仅为本报告；短临时路径、运行时选择和浏览器测试分批属于测试环境调整。

**逐项结果**

| 测试项                                | 结果             | 证据与边界                                                                                                                                                             |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本机安装、完整构建                    | PASS             | Node 24 下 `npm ci --no-audit --no-fund` 安装 261 个包；TypeScript、Vite、esbuild 均成功；生成 `dist/server.mjs` 和 Web 产物                                           |
| Node 24 单元回归                      | FAIL             | 最终 112 通过、1 跳过；另有 gateway 文件级失败：大文件用例断言通过后触发异步 `write EPIPE`，进程退出 1                                                                 |
| Node 26 单元回归                      | PASS             | 113 项：112 通过、1 个 Windows 专用用例跳过，退出 0；gateway 单独对照也通过                                                                                            |
| 浏览器回归                            | PASS（分批）     | 工作空间与会话同步 12/12；新建目标与附件 8/8，均包含 desktop/mobile Chromium 模拟环境，桌面控制器为 fixture                                                            |
| 真实历史读取                          | PASS             | 初始只读上下文读取 36 条；真实 client 经 Server 读取 61 条并列出 65 个会话；专用测试会话最后读取 13 条，包含压缩记录，无 warnings                                      |
| tools RPC：agent Node 24              | FAIL             | `DesktopBridge.projects/state` 建立连接后关闭，无 RPC 响应；相同时刻桌面记录 `untrusted-code-signing-identity`                                                         |
| tools RPC：普通 Terminal Node 24      | FAIL             | 通过 Terminal 的 zsh，在 `env -i`、无 CODEX_* 继承变量环境下运行同一 Node；返回 EPIPE/连接关闭；桌面记录 `untrusted-process-ancestry`                                  |
| tools RPC：真实 dist client / Node 26 | FAIL             | dist client 对应 `missing-code-signing-identity`；Node 26 对照对应 `untrusted-code-signing-identity`；均无成功回执                                                     |
| tools 默认发现                        | 未实现           | 未传 pipe 且无继承变量时连接失败；`server/desktop.ts:72` 的扫描分支仅实现 Windows                                                                                      |
| CLI 模型与目标                        | PASS（独立通道） | 返回 9 个模型；专用会话目标从 null 开始，set active、pause、resume、get、clear 均成功；最后确认目标为空                                                                |
| owner 初始化与归属发现                | PASS             | 正常 Node 经默认 `~/.codex/ipc/ipc.sock` 完成 initialize、thread-owner-discovery，找到当前桌面 owner                                                                   |
| owner 停止                            | PASS             | 专用会话运行中的 turnId `01a1deeb-24f7-76e1-b345-f1dc57d616d0` 被匹配停止；桌面随后报告 interrupted，目标由 active 自动变 paused，随后清除                             |
| owner 压缩                            | PASS             | 提交后约 26,997 ms 观察到新的 contextCompaction 项及 completed turn；真实 client HTTP 历史也可见完成记录                                                               |
| Server 联通、SSE、退出                | PASS             | 平台 darwin、工作空间在线；收到 SSE update；两次真实 client 均以退出码 0 清理                                                                                          |
| 断线、Server 重启                     | PASS             | 仅中断隔离测试连接，约 1,029 ms 重连；重启隔离 Server 后约 1,028 ms 恢复历史读取；工作空间保持一份                                                                     |
| 图片附件                              | 部分 PASS        | 真实 client 上传/下载 68 字节 PNG，SHA-256 一致；认证、正文图片预览、附件隔离由单测及模拟浏览器回归覆盖；向真实桌面会话发送图片受 tools 阻断                           |
| 真实用量                              | PASS（token）    | 扫描完成后，HTTP 接口、UsageStore 和原始 8 条 native usage 记录一致：input 255,223、output 2,282、total 257,505；313 个文件扫描完成，errors=0；美元价格准确性未验收    |
| 通知上报                              | PASS（隔离回归） | 全量单测覆盖加密双 client、持久化 ACK、去重、重启恢复和本地模拟接收；未向真实外部通知目标投递                                                                          |
| Monitor 新建、发送、运行中追加        | 受阻             | Monitor 新建测试请求返回 HTTP 503 / state=unknown，停在 projects 前置查询；没有通过外部 Node 成功创建会话。专用会话由 Codex 内置工具创建，后续等待指令也由内置工具送入 |
| 网页停止、压缩、目标完整流程          | 受阻             | 底层 owner/CLI 已通过；网页链路的 `bridge.state` 前置检查失败。目标字段读写成功不等于网页执行指令已发送                                                                |
| PTY、浏览器项目终端、sharp            | 不适用/缺失      | 当前快照没有对应依赖、实现或测试，未额外安装这些模块                                                                                                                   |
| 桌面自动拉起、Mac 后台启动器          | 未实现           | `server/config.ts:52` 将 desktopAutoStart 限制为 win32；未找到 Mac Shell 启停器或 LaunchAgent                                                                          |
| 睡眠唤醒、桌面重启、多实例、Intel     | 未测             | 本次只覆盖一台 arm64 Mac；未重启用户正在使用的桌面或改变整机网络                                                                                                       |

owner 停止验证的是正在执行的模型轮次；同步停止发生在新轮次开始约 3 秒后，不作为 Shell 子进程回收验收。此前另一轮 45 秒等待已自然结束，针对已结束 turn 的停止明确返回 `interruptedTurnId:null`，未误停后续轮次、未暂停仍 active 的目标；该记录保留在原始日志中。

**P0 鉴权证据（本地时间）**

| 时间                        | 进程/请求                                         | 桌面日志中的拒绝原因              |
| --------------------------- | ------------------------------------------------- | --------------------------------- |
| 19:03:03.343 / .373 / .650  | agent 环境的普通 Node 24，projects/state/原始封包 | `untrusted-code-signing-identity` |
| 19:07:57.549 / 19:07:59.177 | 构建后的 client，control 查询和新建前置查询       | `missing-code-signing-identity`   |
| 19:12:21.195 / .197         | 普通 Terminal 的 Node 24，无 CODEX_* 环境         | `untrusted-process-ancestry`      |
| 19:15:43.380 / .411         | agent 环境的 Node 26，只读原始封包                | `untrusted-code-signing-identity` |

以上均为同一 UID、保留原桌面签名与鉴权设置的实测。签名信息证明所用 Node 24 带 Node.js Foundation 的 Developer ID 签名，该签名仍未被本桌面接受。结论限定于表中版本和运行环境，不外推其他 Mac 构建或未来集成方式。内置工具能够创建测试会话，不能替代外部 Node 的验证。

新建请求 ID 为 `7c60fc30-2870-47c2-b544-4d2937205e8b`；保留 HTTP 503/unknown 回执，未重发该请求。服务停止后只读查询 client 持久化数据库，原 request ID 仍为 unknown，threadId 为空（`05-create-receipt-readback.json`）。代码路径显示失败发生在 `bridge.projects`，尚未调用 `create_thread`；同一时间有桌面 peer 拒绝日志。后续测试会话的创建来自独立的内置工具操作。

**首轮失败与复测**

1. 首轮并行执行构建与单测，结果为 110 通过、3 失败、1 跳过。`server-client.test.ts:95` 在构建产物尚未就绪时读首页得到 503；构建结束后复测通过。该项由测试执行时序引入。
2. `message-images.test.ts:126` 比较 `/tmp/...` 与产品返回的 `/private/tmp/...` 字符串而失败。将 TMPDIR 从 `/tmp/cmm.VzEPHt` 改为其 realpath `/private/tmp/cmm.VzEPHt` 后通过，产品逻辑与测试代码均未改动。
3. `gateway.test.ts:144` 在 Node 24 多次复现：3 条业务断言通过，测试结束后的 `WriteWrap.onWriteComplete` 报 EPIPE，导致文件级失败。Node 26 单独与全量回归均通过。尚未确定应由 Node、请求生命周期还是 fixture 关闭时序修复，不能称 Node 24 全量通过。
4. 20 个浏览器用例共用一个 Server 的首轮结果为 19 通过、1 失败。trace 证明失败位于登录前置步骤：`POST /api/auth/login` 返回 429，而非目标恢复断言。当前 `createAuthRateLimiter` 按来源地址在 60 秒内限制 12 次。分为两个全新测试 Server 运行后，12+8 项全部通过。
5. 原系统临时目录下 state/interrupt 的示例 socket 路径分别为 104/108 字节，展开 realpath 为 112/116 字节；短目录的规范路径则为 79/83 字节。本次使用后者，没有以默认长路径验收 socket fixture。

**复现命令**

以下在仓库根目录执行；短临时目录仅用于测试 fixture。两轮浏览器测试由各自启动的 Server 隔离登录限流。

```bash
export MAC_TEST_OUT="$HOME/codex-monitor-macos-handoff.hTqPj6"
export MAC_TEST_TMP=/private/tmp/cmm.VzEPHt
export MAC_NODE24="$HOME/.nvm/versions/node/v24.13.0/bin/node"
export MAC_NODE26="$HOME/.nvm/versions/node/v26.12.1/bin/node"
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"

npm ci --no-audit --no-fund
npm run build

TMPDIR="$MAC_TEST_TMP" "$MAC_NODE24" --disable-warning=ExperimentalWarning \
  --import tsx --test --test-reporter=spec tests/*.test.ts
TMPDIR="$MAC_TEST_TMP" "$MAC_NODE26" --disable-warning=ExperimentalWarning \
  --import tsx --test --test-reporter=spec tests/*.test.ts

TMPDIR="$MAC_TEST_TMP" \
MONITOR_TEST_ROOT="$MAC_TEST_TMP/codex-monitor-e2e-handoff" \
MONITOR_TEST_PORT=14327 \
PLAYWRIGHT_HTML_OUTPUT_DIR="$MAC_TEST_OUT/playwright-handoff-report" \
npm exec -- playwright test tests/e2e/workspaces.spec.ts tests/e2e/session-sync.spec.ts \
  --output "$MAC_TEST_OUT/playwright-handoff-results"

TMPDIR="$MAC_TEST_TMP" \
MONITOR_TEST_ROOT="$MAC_TEST_TMP/codex-monitor-e2e-goals" \
MONITOR_TEST_PORT=14327 \
PLAYWRIGHT_HTML_OUTPUT_DIR="$MAC_TEST_OUT/playwright-goal-report" \
npm exec -- playwright test tests/e2e/new-session-goal.spec.ts \
  --output "$MAC_TEST_OUT/playwright-goal-results"

# 普通 Terminal 中运行；探针的 pipe/context 绑定本次已发现的实例和专用会话。
# 桌面重启后需先核对 socket 路径。
env -i HOME="$HOME" USER="$USER" \
  PATH="$HOME/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin" \
  TMPDIR="$MAC_TEST_TMP" \
  "$MAC_NODE24" "$MAC_TEST_OUT/tools-readonly.mjs" terminal
```

`baseline.mjs`、`integration.mjs`、`goals.mjs`、`owner-watcher.mjs`、`final-native.mjs` 保存在私有证据目录，用于审阅本次封包和操作过程。它们绑定本次路径/会话；`integration.mjs` 含首次初始化步骤，重跑需使用新的隔离输出和数据目录。

**证据索引与最小后续工作**

| 证据               | 私有目录中的文件                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 安装与构建         | `01-environment.log`、`01-node-signature.log`、`01-desktop-version.log`、`01-source-sha256.txt`、`02-npm-ci.log`、`02-build.log`         |
| 单测原始与复测     | `02-all-unit-tests.log`、`02-retest-canonical-tmp.log`、`02-final-all-unit-tests.log`、`02-gateway-node26.log`、`02-all-unit-node26.log` |
| tools 与拒绝原因   | `baseline-results.jsonl`、`03-tools-terminal.log`、`03-tools-node26.log`、`03-desktop-peer-evidence.log`                                 |
| 真实 Server/client | `integration-results.jsonl`、`05-integration.log`、`05-client-private.log`、`05-final-usage-client-private.log`                          |
| 专用会话控制与用量 | `test-context.json`、`controls-results.jsonl` 及临时探针脚本                                                                             |
| 浏览器             | `06-browser-tests.log`、`06-browser-handoff-isolated.log`、`06-browser-goals-isolated.log`、对应 HTML report、截图和 trace               |

P0 应先确定桌面支持的外部集成入口及进程授权条件。为现有 Node client 补 socket 扫描、显式路径或 LaunchAgent，无法解除已证实的 peer 鉴权拒绝；完整控制的工期需要重估。只读模式可继续交付，在控制不可用时应向用户清楚显示原因。

随后可在 `server/desktop.ts` 补 macOS 的同用户 socket 发现、多实例选择与底层错误诊断；在 `server/native.ts` 补应用包 CLI 发现或部署时固定当前绝对 CLI 路径；在 `server/config.ts`、桌面守护和新 Mac 启停脚本中实现后台运行与退出清理。终端功能需先取得包含对应实现的完整快照，再执行真实 Bash/zsh PTY 验收。

测试适配优先处理 `tests/message-images.test.ts` 的 realpath 等价判断、socket fixture 的短目录、gateway 的 HTTP 写入/关闭生命周期，以及浏览器测试的登录状态复用或 Server 隔离。生产登录限流无需为测试放宽。

测试结束时专用会话为空闲状态，测试目标已清除；隔离 Server 和 client 均已退出。原始日志保留在本机私有目录，仓库报告仅包含版本、状态、测试标记和脱敏路径。
