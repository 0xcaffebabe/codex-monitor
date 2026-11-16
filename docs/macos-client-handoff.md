# macOS client 可行性测试 Handoff

> 后续实现与部署说明见 [macOS client](macos-client.md)，2026-11-15 至 16 日的最终结果见 [实现与验收报告](macos-client-implementation-report.md)。本文保留最初的实机测试步骤和当时的实现状态。

编写于 2026-11-15，供在 macOS 真机上工作的 agent 接手。目标是验证当前 Codex Monitor client 的实际兼容范围，优先回答：**使用正常部署的 Node.js 进程，能否通过 macOS Codex 桌面的本机通信鉴权？**

可直接交给接手 agent 的任务说明：

> 请依据本 handoff 在 macOS 上测试 codex-monitor client。先记录代码快照和机器环境，再验证安装、真实历史读取、桌面 tools socket、CLI stdio 和 owner IPC，之后做 Server 联通与专用测试会话的端到端验证。使用指定的测试项目和会话承接真实发送、新建、停止、压缩及目标操作。缺少真实控制测试上下文时，先完成其余检查并列出缺口。输出可复现命令、脱敏证据、逐项结果和最小适配建议；记录修改前后结果。重点区分已证实的兼容性、未实现功能和仍需验证的假设。

**已有结论与证据边界**

基础架构可复用：client 主动连接 Server，读取本机 SQLite / JSONL，扫描并上报通知事件。桌面控制已有 Unix socket 通信基础，但 macOS 自动发现和桌面自动拉起尚未实现。项目终端已有非 Windows Shell 分支。

Windows 阶段检查了已安装桌面包 `OpenAI.Codex_26.1111.2228.0_x64` 的共享 JavaScript：macOS tools socket 使用 `/tmp/codex-app-tools/<UUID>.sock` 的实现线索；darwin 的正式版、公测版等构建会调用 `browser-use-peer-authorization.node` 的 `authorizeSocketPeer` 检查对端进程。**这不能证明目标 Mac 包采用完全相同的实现，也不能证明普通 Node 会通过或一定会被拒绝。**

此前 Windows 上 28 项相关测试通过，覆盖 CLI、加密、多 client、历史、桌面状态、停止、NativeRpc 生命周期和构建后启动；测试桌面是模拟服务。这不包含 Mac 真机验证，也不代表后来新增的终端、图片依赖等都已完成回归。

编写时 Windows 工作区 HEAD 为 `971119d83c86596fc120e32eacf07a4bb0974d17`，仍有未提交修改及新文件。早期评估曾基于更早的工作区，因此不要只按提交号推断功能是否齐全。Mac 端应核对实际源文件和依赖；只拉取某个提交，可能缺少尚未提交的 client、通知或终端实现。

**1. 先确认接手输入与环境**

| 输入                                         | 用途                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 完整的当前代码快照                           | 包括 package.json、lockfile、server/client、协议、通知与终端等实际实现             |
| 目标桌面应用路径、版本、构建渠道             | 应为提供 Codex 能力的桌面应用；包名可能是 Codex.app 或 ChatGPT.app，以实际内容为准 |
| 同一登录用户的 Codex 数据目录                | 默认 ~/.codex；通过参数传入，不改写已有配置或复制数据库覆盖原目录                  |
| 专用测试项目和测试会话 ID                    | 只读探针使用该会话作为上下文；真实控制也在该测试范围内执行                         |
| Server origin、独立工作空间 ID、AES 密钥文件 | 用于接入现有 Server；没有时可启动本文给出的隔离本机 Server                         |

Node.js 要求为项目声明的 24+。记录 macOS 版本、Apple Silicon / Intel、Node 的实际 process.arch，以及是否在 Rosetta 下运行。桌面版系统要求以[官方说明](https://help.openai.com/en/articles/9275200-downloading-the-chatgpt-macos-app)和实际安装包为准。

以下命令在 **Mac 的仓库根目录**使用 bash 或 zsh 执行；先替换标明的实际路径。MAC_* 是本次测试变量，原有 HOME 和 CODEX_HOME 保持原意。测试输出放在仓库外，使用短的临时目录，避免 macOS Unix socket 路径长度限制。

```bash
umask 077
set -o pipefail
export MAC_TEST_OUT="$(mktemp -d "$HOME/codex-monitor-macos-handoff.XXXXXX")"
export MAC_TEST_TMP="$(mktemp -d /tmp/codex-monitor-mac.XXXXXX)"
export MAC_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

{
  sw_vers
  uname -m
  node --version
  npm --version
  node -p 'JSON.stringify({execPath:process.execPath,arch:process.arch,platform:process.platform,uid:process.getuid?.(),shell:process.env.SHELL,tmpdir:require("node:os").tmpdir()})'
  git rev-parse HEAD
  git status --short
} 2>&1 | tee "$MAC_TEST_OUT/01-environment.log"
git diff --stat > "$MAC_TEST_OUT/01-working-tree-stat.txt"
```

在结果中区分“Mac agent 自己可调用 Codex 内置工具”和“外部 Node client 可连接”。验证时应使用将来部署 client 的同一个 Node 可执行文件，记录 process.execPath。若只在 Codex 启动的 agent 环境成功，还要在普通 Terminal 环境复测，排除继承环境和运行时差异。

按实际安装包填写应用与 CLI 路径，然后记录版本。不要把下方示例包名当作自动发现结果。

```bash
export MAC_APP_BUNDLE="/Applications/实际应用.app"
export MAC_CODEX_CLI="$MAC_APP_BUNDLE/Contents/Resources/codex"

{
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$MAC_APP_BUNDLE/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$MAC_APP_BUNDLE/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$MAC_APP_BUNDLE/Contents/Info.plist"
  file "$MAC_CODEX_CLI"
  "$MAC_CODEX_CLI" --version
} 2>&1 | tee "$MAC_TEST_OUT/01-desktop-version.log"
codesign -dv --verbose=2 "$(command -v node)" > "$MAC_TEST_OUT/01-node-signature.log" 2>&1
```

未签名的 Node 在最后一条命令返回非零可以作为环境证据；这条命令不是功能验收。原生鉴权的真实规则需要通过请求结果及桌面日志确认。

**2. 明确各通道与代码入口**

下表路径以接手机器的仓库根目录为基准；按函数名定位，行号可能随开发变化。

| 通道 / 能力       | 代码入口                                                                                                                          | 当前行为与 Mac 测试重点                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Server ↔ client   | server/client/connection.ts、server/client/config.ts、server/transport/protocol.ts                                                | 主动 WebSocket，HMAC 握手及 AES-256-GCM 业务加密；当前协议版本 v3，Server/client 必须匹配                                                     |
| 桌面 tools socket | server/desktop.ts：DesktopBridge.connect / call                                                                                   | 显式 options.pipe / MONITOR_CODEX_PIPE，或继承 CODEX_APP_TOOLS_PIPE_PATH；只有 Windows 会自动扫描实例                                         |
| tools 请求        | 同上：projects / state / send / create                                                                                            | 4 字节小端长度头 + JSON-RPC tools/call，调用 list_projects、list_threads、send_message_to_thread、create_thread                               |
| owner IPC         | server/native.ts：requestOwnedThread、compactOwnedThread、interruptOwnedThread                                                    | 非 Windows 默认 CODEX_HOME/ipc/ipc.sock；先 initialize、thread-owner-discovery，再转交给 owner                                                |
| 模型与目标        | server/native.ts：cliPath、NativeRpc                                                                                              | 启动 codex app-server --listen stdio://；MONITOR_CODEX_CLI / CODEX_APP_RUNTIME_CLI_PATH 优先，非 Windows 回退 PATH 中的 codex                 |
| 本地记录          | server/source.ts、server/source/databases.ts、server/source/rollouts.ts                                                           | 只读 state__.sqlite、thread_history__.sqlite，兼容 JSONL；图片、附件、用量也依赖本机路径                                                      |
| 项目终端          | server/terminal.ts、server/terminal-process.ts、server/terminal-worker.mjs、server/http/terminal-routes.ts、src/features/terminal | 独立 worker 承载 node-pty，父子进程通过 Node IPC 通信；非 Windows 使用 SHELL，缺省 /bin/bash，参数 -i；测试 zsh、环境、交互、退出及子进程回收 |
| 桌面自动拉起      | server/config.ts、server/desktop-watchdog.ts                                                                                      | desktopAutoStart 被 process.platform === 'win32' 限制；Mac 即使传 true 也不会启用                                                             |
| client 启动       | server/index.ts、server/cli.ts、docs/server-client.md                                                                             | npm / Node 命令可启动；不会自动加载 .env；start.ps1 / stop.ps1 为 Windows 启停器                                                              |

tools socket、owner IPC 和 CLI stdio 是三个独立通道。`--codex-pipe` 仅选择 tools socket，不会覆盖 owner IPC；`--codex-cli` 也不会指定桌面 GUI。owner IPC 的原始协议与公开 app-server 的 Unix WebSocket transport 不同，不能混用地址或封包。

**3. 安装和自动化基线**

在 Mac 本机安装依赖。当前工作区包含 node-pty 1.1.0，Windows 侧依赖包中已看到 darwin-arm64 / darwin-x64 预编译文件；编写时 package.json 还新增了 sharp。以本机 lockfile 为准，分别验证原生模块，不能复用 Windows node_modules。

```bash
npm ci 2>&1 | tee "$MAC_TEST_OUT/02-npm-ci.log"
npm run build 2>&1 | tee "$MAC_TEST_OUT/02-build.log"

node --input-type=module <<'NODE' 2>&1 | tee "$MAC_TEST_OUT/02-native-dependencies.log"
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const pty = require('node-pty');
console.log(JSON.stringify({check:'node-pty-load',ok:typeof pty.spawn === 'function',arch:process.arch}));
if (pkg.dependencies?.sharp) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp({create:{width:2,height:2,channels:4,background:'#336699'}})
    .png().toBuffer({resolveWithObject:true});
  console.log(JSON.stringify({check:'sharp-load-and-encode',ok:data.length > 0,format:info.format}));
}
NODE
```

安装失败时先记录 CPU / Node 架构、预编译包是否存在和安装日志。node-pty 可能回退 node-gyp；确需本机编译时再补 Python / Xcode 工具链。sharp 还需检查 optional dependencies 是否被省略。依赖加载、PTY 真正创建、Shell 能正常交互分别验收。

```bash
TMPDIR="$MAC_TEST_TMP" node --disable-warning=ExperimentalWarning --import tsx \
  --test --test-reporter=spec \
  tests/cli.test.ts tests/transport.test.ts tests/core.test.ts \
  tests/native-lifecycle.test.ts tests/desktop-state.test.ts \
  tests/interrupt.test.ts tests/server-client.test.ts tests/client-startup.test.ts \
  2>&1 | tee "$MAC_TEST_OUT/02-core-tests.log"
```

有 `tests/terminal.test.ts` 时先测受控的 Bash，再测实际默认 Shell：

```bash
TMPDIR="$MAC_TEST_TMP" SHELL=/bin/bash node --disable-warning=ExperimentalWarning \
  --import tsx --test --test-reporter=spec tests/terminal.test.ts \
  2>&1 | tee "$MAC_TEST_OUT/02-terminal-bash.log"
```

已知测试干扰因素：

- `tests/desktop-state.test.ts`、`tests/interrupt.test.ts` 在 os.tmpdir() 下拼接较长 UUID socket 名。macOS 系统临时路径较长时可能超过 Unix socket 限制，先使用上面的短 TMPDIR；记录原始与展开路径的字节长度。
- 当前 `tests/terminal.test.ts` 的非 Windows 提示符判断包含 `/[$#] /`。macOS zsh 常用 `% `，自定义 Bash 提示符也可能不同。超时需要区分提示符匹配失败和 PTY 故障；受控 Bash 可通过临时 Shell 包装器执行 `/bin/bash --noprofile --norc "$@"`，后续仍需单独验证真实 zsh。测试环境修正应单独记录，不能据此宣称产品逻辑已经修复。
- fixture 中部分会话 cwd 是 Windows 示例路径，涉及真实终端的测试要使用测试器创建的本机临时项目。整套测试可能包含其他 Windows 假设，按具体失败定位。
- 这些测试能验证 Mac 上的模拟桌面协议和真实 PTY，不能替代下面的真实桌面鉴权测试。

**4. 优先验证 tools socket 和进程鉴权（P0）**

打开并登录目标桌面应用，在其中打开专用测试会话。先检查实际 socket。下面的只读脚本列出已知候选目录中当前用户拥有的 socket，以及默认 owner 路径；目录不存在只表示线索未匹配，不直接判定平台不支持。

```bash
node --input-type=module <<'NODE' 2>&1 | tee "$MAC_TEST_OUT/03-socket-inventory.log"
import fs from 'node:fs';
import path from 'node:path';
const uid = process.getuid?.();
for (const dir of ['/tmp/codex-app-tools']) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSocket() && stat.uid === uid)
        console.log(JSON.stringify({kind:'tools-candidate',path:file,uid:stat.uid,mode:(stat.mode & 0o777).toString(8),bytes:Buffer.byteLength(file)}));
    }
  } catch (error) {
    console.log(JSON.stringify({kind:'inventory',dir,code:error.code}));
  }
}
const inherited = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (inherited) console.log(JSON.stringify({kind:'inherited-tools-path',path:inherited}));
const owner = path.join(process.env.MAC_CODEX_HOME, 'ipc', 'ipc.sock');
try {
  const stat = fs.statSync(owner);
  console.log(JSON.stringify({kind:'owner-default',path:owner,realpath:fs.realpathSync(owner),isSocket:stat.isSocket(),uid:stat.uid,bytes:Buffer.byteLength(owner)}));
} catch (error) {
  console.log(JSON.stringify({kind:'owner-default',path:owner,code:error.code}));
}
NODE
```

候选目录未匹配时，在目标 Mac 上检查桌面日志和安装包中的 `CODEX_APP_TOOLS_PIPE_PATH`、`dynamic_app_tools_listening`、`nativePipeDirectory`、`codex-app-tools`。有多个实例时确认归属，显式选择一个；不要盲目批量发送请求或删除未知 socket。

填写实际发现的路径和专用测试会话 ID，使用现有 DesktopBridge 发送只读请求：

```bash
export MAC_TOOLS_SOCKET="/tmp/codex-app-tools/实际实例.sock"
export MAC_TEST_THREAD="实际专用测试会话ID"

node --import tsx --input-type=module <<'NODE' 2>&1 | tee "$MAC_TEST_OUT/03-tools-readonly.log"
import { DesktopBridge } from './server/desktop.ts';
const socket = process.env.MAC_TOOLS_SOCKET;
const thread = process.env.MAC_TEST_THREAD;
if (!socket || !thread) throw new Error('Set MAC_TOOLS_SOCKET and MAC_TEST_THREAD first');
const bridge = new DesktopBridge({pipe:socket,codexHome:process.env.MAC_CODEX_HOME,timeoutMs:8000});
try {
  for (const [check, run] of [
    ['projects', async () => ({count:(await bridge.projects(thread)).length})],
    ['state', async () => ({status:(await bridge.state(thread,thread)).status})],
  ]) {
    try {
      const result = await run();
      console.log(JSON.stringify({check,ok:true,...result}));
    } catch (error) {
      process.exitCode = 1;
      console.error(JSON.stringify({check,ok:false,name:error.name,message:error.message,status:error.status,uncertain:error.uncertain,code:error.code}));
    }
  }
} finally {
  bridge.close();
}
NODE
```

通过条件是：外部 Node 收到合法、成功且内容可解析的 tools 回执，项目数量合理，指定会话状态与桌面一致。**socket 文件存在、net.connect 成功或 Codex 内置 MCP 工具可用，都不足以证明此项通过。**

失败时记录操作时间、Node 路径与签名信息、socket 路径 / owner / mode、底层错误与回执。结合相同时刻桌面日志中的 `dynamic_app_tools_peer_rejected`、`dynamic_app_tools_peer_authorization_failed` 等证据判断。只看到连接关闭或超时，应标注“原因未确认”，不能直接断言签名校验失败。

如果需要补诊断日志，可以在临时探针中保留 net.Socket 的 error.code、close 和响应类型；使用相同封包与请求字段。保留正式版的原有鉴权与系统权限，以实际将部署的进程进行验证。通过关闭鉴权、修改桌面签名或换开发版取得的结果，不能作为正式版兼容结论。

**5. 分别验证真实历史、CLI stdio 和 owner IPC**

真实历史只读探针只输出数量和状态，不转储会话正文：

```bash
node --import tsx --input-type=module <<'NODE' 2>&1 | tee "$MAC_TEST_OUT/04-source-readonly.log"
import { CodexSource } from './server/source.ts';
const source = new CodexSource(process.env.MAC_CODEX_HOME);
try {
  await source.refresh(true);
  const thread = process.env.MAC_TEST_THREAD;
  if (!thread) throw new Error('Set MAC_TEST_THREAD first');
  const session = await source.get(thread);
  if (!session) throw new Error('Test thread not found in selected Codex home');
  const page = await source.detail(thread);
  console.log(JSON.stringify({check:'source-read',ok:true,historyMode:session.historyMode,events:page?.events.length ?? 0,activity:source.activity(thread) ?? null}));
} finally {
  source.close();
}
NODE

MONITOR_CODEX_CLI="$MAC_CODEX_CLI" node --import tsx --input-type=module <<'NODE' \
  2>&1 | tee "$MAC_TEST_OUT/04-native-readonly.log"
import { NativeRpc } from './server/native.ts';
const rpc = new NativeRpc(process.env.MAC_CODEX_HOME);
try {
  for (const [check, run] of [
    ['models', async () => ({count:(await rpc.models()).length})],
    ['goal-get', async () => {
      const thread = process.env.MAC_TEST_THREAD;
      if (!thread) throw new Error('Set MAC_TEST_THREAD first');
      const goal = await rpc.get(thread);
      return {exists:goal != null,status:goal?.status ?? null};
    }],
  ]) {
    try {
      console.log(JSON.stringify({check,ok:true,...await run()}));
    } catch (error) {
      process.exitCode = 1;
      console.error(JSON.stringify({check,ok:false,name:error.name,message:error.message,status:error.status,uncertain:error.uncertain}));
    }
  }
} finally {
  rpc.close();
}
NODE
```

检查模型列表是否非空；无目标的专用会话返回 null 是合法结果。历史探针返回零条事件时，应使用有已知记录的专用会话复测，不能只按 ok 字段判定历史读取通过。models / goal-get 成功只证明 stdio 这条通道可用，不能替代 tools socket 的验证。

owner IPC 先核对默认路径与桌面实际路径。Windows 包中的共享实现存在 Unix 长路径回退线索，不能假设自定义 CODEX_HOME 下总是直接使用拼接路径。实际发现与默认路径不一致时，记录目录、realpath、路径字节数和桌面实现。

停止 / 压缩通过下一阶段的正式 UI 测试验证。需要定位传输差异时，现有函数 `compactOwnedThread(threadId, codexHome, endpoint)` 和 `interruptOwnedThread(threadId, turnId, codexHome, endpoint)` 支持内部显式 endpoint；CLI 没有对应的 owner endpoint 参数。显式 endpoint 成功、产品默认路径失败，应记录为“通道可用，默认发现或配置待适配”。

若 tools 鉴权失败，仍继续独立的 source / stdio / 模拟 owner 协议测试。在正式 UI 中，控制动作通常还会调用 bridge.state；所以底层 owner 或目标 RPC 可用，不代表 UI 的完整控制链路可用。

**6. 接入 Server，并做专用会话端到端验证**

现有 Server 应注册新的 Mac 测试工作空间，保留其他机器的工作空间身份。没有可用 Server 时，先在独立终端启动隔离本机 Server：

```bash
# 使用同一仓库与前面生成的 MAC_TEST_OUT；选择未被占用的端口。
node dist/server.mjs --mode server --host 127.0.0.1 --port 14319 \
  --data-dir "$MAC_TEST_OUT/server-data" \
  2>&1 | tee "$MAC_TEST_OUT/05-local-server-private.log"
```

打开该 Server 页面，用私有首次设置入口创建测试管理员，再在“管理工作空间”注册 Mac。首次设置日志可能含 setup key，仅保存在本机私有输出目录；共享报告引用时去除凭据。

在启动 client 的终端中，填写 Server 页面生成的配置。密钥通过权限受限的文本文件传入，日志中不打印正文。

```bash
export MAC_SERVER_URL="http://127.0.0.1:14319"
export MAC_WORKSPACE_ID="注册的Mac工作空间UUID"
export MAC_CLIENT_KEY_FILE="/实际私有目录/mac-client.key"

npm run client -- \
  --server-url "$MAC_SERVER_URL" \
  --workspace-id "$MAC_WORKSPACE_ID" \
  --client-key-file "$MAC_CLIENT_KEY_FILE" \
  --codex-home "$MAC_CODEX_HOME" \
  --data-dir "$MAC_TEST_OUT/client-data" \
  --codex-cli "$MAC_CODEX_CLI" \
  --codex-pipe "$MAC_TOOLS_SOCKET" \
  --codex-autostart false \
  2>&1 | tee "$MAC_TEST_OUT/05-client.log"
```

先可加 `--check-config` 只检查配置；配置有效不代表 socket 或 Server 可用。Server URL 只填写 origin，跨机器时使用 Mac 可达的地址；两端协议版本和系统时间也需匹配，当前 HMAC 握手允许约 60 秒时钟偏差。上述为显式配置测试，仍需另测不传 tools socket / CLI 参数的默认发现。当前 Mac 无自动扫描时默认发现失败属于待适配项。

| 测试项            | 执行方法与通过标准                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 上线与读取        | Server 显示独立 Mac 工作空间在线、平台 darwin；列表与专用会话正文和桌面一致                                                      |
| 实时历史          | 测试会话执行后，已持久化内容进入监控页；记录延迟，区分数据库落盘与逐 token 流式输出                                              |
| 空闲发送          | 向专用会话发送带唯一测试标记的简短指令；桌面收到一次，监控回执与历史一致                                                         |
| 运行中追加        | 在可控短任务运行中追加标记；由原桌面 owner 处理，消息不重复，状态正确                                                            |
| 新建会话          | 在指定空测试项目中创建一次；返回会话与桌面、监控列表一致，没有重复创建                                                           |
| 停止              | 在专用会话执行可控等待任务，点击停止；回执对应当前 turnId，任务终止；设置了目标时还要核对目标暂停语义                            |
| 压缩              | 专用会话空闲且具备可压缩上下文时提交；桌面记录显示完成。上下文不足或桌面不支持时记录实际结果，不能把无条件返回成功当验收         |
| 目标              | 在专用会话设置可短时间完成的目标，验证读取、暂停、继续、清除；设置／继续可能启动执行，不要只以目标字段写入成功判整条链路通过     |
| 附件与图片        | 使用本次测试文件上传、读取、预览和发送；确认文件落在 Mac client、路径可由目标会话访问；图片转换以当前 checkout 功能为准          |
| 用量              | 对专用会话核对原始记录和页面数值；统计配置、时间范围一致                                                                         |
| 通知上报          | 验证 client 扫描、Server 接收及去重；使用隔离 Server 或本地模拟接收端。真实外部通知另按用户提供的测试范围执行                    |
| 断网 / 重连       | 临时中断测试连接后恢复，观察指数退避、工作空间重连、读取恢复；不确定回执按原请求 ID 查询，不能自动重发控制操作                   |
| 桌面重启 / 多实例 | 使用专用测试环境验证 socket 路径变化与重新选择；记录显式旧 socket 与默认发现的差异；重启影响其他工作时先完成独立检查并列出未测项 |

真实操作一旦出现“结果待确认”，先检查桌面、历史与持久回执。记录请求 ID 与测试标记，核对后再决定下一步；不能靠盲目重试判断协议是否可用。

**7. 终端、浏览器与长期运行**

项目终端应使用本次创建的 Mac 临时项目目录，验证当前工作目录、持久变量、中文、Ctrl+C、缩放、Shell 退出码、关闭、权限撤销及子进程回收。分别测试受控 Bash 和目标用户实际 zsh。直接 import node-pty 成功还不够，至少运行一次真实 PTY 测试。

最新工作区已将原生 PTY 放入独立 worker。按当前 package.json 完整运行构建，确认 dist/server.mjs 和 dist/terminal-worker.mjs 均存在；只复制 server.mjs 会遗漏终端子进程入口。Mac 侧还应验证关闭终端、client 断线及退出后 worker 与 Shell 子进程都能回收。

有对应测试文件时执行浏览器回归。测试器会重建 MONITOR_TEST_ROOT，因此该变量必须指向专用测试临时目录，不能指向真实 Codex 数据或已有工作目录。

```bash
npx playwright install chromium 2>&1 | tee "$MAC_TEST_OUT/06-playwright-install.log"

TMPDIR="$MAC_TEST_TMP" \
MONITOR_TEST_ROOT="$MAC_TEST_TMP/codex-monitor-e2e" \
MONITOR_TEST_PORT=14327 \
PLAYWRIGHT_HTML_OUTPUT_DIR="$MAC_TEST_OUT/playwright-report" \
npx playwright test tests/e2e/workspaces.spec.ts tests/e2e/session-sync.spec.ts \
  tests/e2e/terminal.spec.ts --output "$MAC_TEST_OUT/playwright-results" \
  2>&1 | tee "$MAC_TEST_OUT/06-browser-tests.log"
```

端口有占用时选择其他空闲端口。E2E 使用模拟 Codex 控制器，证明 Web 与传输链路在 Mac 测试环境可用，仍不能替代真实桌面鉴权和 owner 控制。

Mac 自动拉起、start/stop Shell 脚本及 LaunchAgent 目前是待实现项。即使前台 client 通过，也要把它们单独标注。控制通道通过后再评估最小适配：用户 LaunchAgent、明确的 Node / CLI 绝对路径、SHELL / PATH、独立数据目录、日志与退出清理；参考 [Apple LaunchAgent 文档](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。

长期运行检查还应覆盖睡眠唤醒、Server 重启、用户退出和重新登录。后台环境不能依赖交互式 Shell 配置；GUI 登录与 client 用户、CODEX_HOME 的对应关系必须明确。只测试了一个 CPU 架构时，另一个架构保留为未测。

**8. 失败归类与下一步**

| 现象                              | 首先核查                                                 | 结论边界                                                   |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| npm ci / 原生模块加载失败         | Node 与依赖架构、预编译、optional dependencies、编译日志 | 安装问题；尚不能据此判断桌面 IPC 不支持                    |
| 工具 socket 不存在                | 实际桌面包、是否启动、目录规则、实例及日志               | 发现或版本问题；不等于鉴权拒绝                             |
| EACCES / EPERM                    | 同一 UID、目录与 socket mode、实际错误来源               | 先定位具体权限；不要预先升级为 root 或改变权限掩盖部署条件 |
| connect 成功但请求被关闭          | 对端鉴权日志、帧格式、API / 构建版本、上下文 threadId    | 有明确拒绝证据才判定 peer authorization；否则原因未确认    |
| projects 成功但 state / send 失败 | 测试会话是否属于本机、是否加载、会话状态及工具回执       | 单项工具或上下文问题，不等于整个通道不可用                 |
| CLI ENOENT                        | 显式 CLI、应用包路径、后台 PATH                          | CLI 发现缺口；与 tools 鉴权分开                            |
| goal/model 成功、UI 控制失败      | UI 前置的 bridge.state、tools 通道与控制权限             | 不能以 stdio 成功宣称完整桌面控制成功                      |
| 停止 / 压缩失败                   | owner endpoint、会话 owner、版本、turnId 守卫            | 记录 tools 与 owner 各自结果；避免另起 writer 接管原会话   |
| 终端输出超时                      | PTY 是否生成数据、Shell 提示符、zsh 配置、前端轮询       | 区分测试 harness 与产品故障                                |
| 桌面退出后不被自动拉起            | config.ts 的 win32 条件                                  | 当前未实现项，不是连接 Server 的随机故障                   |

不要把公开 app-server 直接作为现有桌面 owner 控制的替代品。它可以独立验证模型和目标 RPC；如果改为由另一进程 resume / steer 桌面运行中的会话，会涉及 writer 归属和现有语义，需要单独设计与测试。

如果正式版明确拒绝正常部署的 Node，保留原始证据，给出两项结论：只读 client 能否交付，以及完整控制是否需要受支持的新集成方式；此时原先约 3–5 个工作日的完整适配估算不再适用。若鉴权通过，主要适配集中在发现、CLI 路径、Mac 守护、后台启动和回归。

**9. 接手 agent 应交付的报告**

将日志、截图、临时探针及报告保存到 MAC_TEST_OUT，代码改动保留最小 diff，报告中分别说明原始结果与修改后结果。共享证据前去除 AES 密钥、登录令牌、首次设置 key、签名私钥和无关会话正文；保留复现所需的版本、错误码与脱敏路径。

推荐报告模板：

```text
机器：macOS / CPU / Rosetta / Node 版本、arch、execPath
桌面：bundle ID / 版本 / 构建渠道 / CLI 版本
代码：commit / 未提交改动 / 实际依赖版本 / 探针或适配 diff
数据：选择的 Codex home / 测试项目与会话 / 使用隔离或现有测试 Server

项目                         状态                     证据
本机安装与构建               PASS/FAIL/未测           命令、退出码、日志
node-pty / sharp              PASS/FAIL/不适用         加载及实际运行结果
真实历史与图片读取           PASS/FAIL/未测           模式、数量、可见性
tools RPC（正常部署 Node）   PASS/FAIL/受阻/未测      路径、上下文、响应及桌面日志
tools RPC（普通 Terminal）   PASS/FAIL/未测           与 agent 环境的差异
tools 默认发现               PASS/FAIL/未实现         显式路径与自动发现分别记录
CLI 模型 / 目标读取          PASS/FAIL/未测           独立 stdio 回执
owner 停止 / 压缩            PASS/FAIL/受阻/未测      实际 endpoint、owner、turn 守卫
Server 联通与重连            PASS/FAIL/受阻/未测      工作空间、协议版本、断线恢复
发送 / 新建 / 运行中追加     各自列结果               专用会话、请求 ID、唯一标记
目标完整流程                 PASS/FAIL/受阻/未测      写入、状态及触发执行
真实 PTY 与浏览器终端        PASS/FAIL/未测           Bash、zsh、中文、退出、清理
桌面守护 / 后台自启          PASS/FAIL/未实现/未测    当前实现与未来方案分开
睡眠唤醒 / 多实例 / 双架构   各自列结果               未覆盖范围明确列出

结论：只读支持程度 / 完整控制支持程度 / 最小必改项 / 未解决风险
若失败：最小复现、错误、是否确定为对端鉴权、可继续独立验证的部分
下一步：建议修改文件、验收条件、是否需要重估工期
```

参考资料：[现有 Server/client 部署文档](server-client.md)、[Node.js IPC 与路径限制](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#ipc-support)、[node-pty](https://github.com/microsoft/node-pty)、[公开 App Server 文档](https://learn.chatgpt.com/docs/app-server)。
