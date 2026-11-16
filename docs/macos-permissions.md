# macOS 会话权限与审批

2026-11-16 更新。此文补充 [macOS client](macos-client.md)，取代旧验收报告中“网页审批尚未支持”的状态。

新会话原先继承本机只读配置，CLI 请求额外权限时，client 又统一返回不支持交互请求，导致 `approval request failed`。现在新建会话默认完全访问，可直接读写文件、执行命令和联网。新建界面也可以选择沿用本机、只读、项目写入、项目写入并联网。

## 实现

- `MacDesktopControl.create` 默认设置 `danger-full-access` 与 `never`，旧版网页省略权限字段也采用此默认值。显式 `inherit` 保留本机策略；已有会话不被批量改写。
- 受限模式使用原 CLI 回调等待用户决定，支持 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。初始化支持原生人工确认能力。
- 新增 `/api/sessions/:id/approvals` 及按审批 ID 查询、答复的接口，沿用加密工作空间传输。读取和答复都校验管理员、会话范围；答复前重新核对中央设备授权与会话状态，并记录审计。
- 浏览器显示原因、命令、目录、网络目标、请求的文件权限和修改差异。“允许本次”只返回单次接受；额外权限只复制原请求范围并授予本轮。网页不能提交任意权限或持久命令规则。
- 回执丢失时先查询原审批 ID；同一决定重复提交返回原结果，相反决定被拒绝。默认 15 分钟过期；CLI 断开、轮次结束、原生请求已解决时取消待审批回调，旧回调不会被转给新进程。
- 文件差异延迟到达时更新原请求；差异未就绪不能批准，移动目标也显示在审批内容中。桌面和手机布局均已验证。

默认完全访问在更新并重新启动 client 后生效；权限下拉框和审批面板需要更新 Server 的前端构建。构建命令仍为 `npm run build`，不增加依赖。原线上 client 按用户要求保持停止，验收服务只监听本机并在结束后关闭。

## 验证

本次使用 Node 26.12.1、Node 24.13.0 和已安装 CLI 0.169.0-alpha.11.1。

| 验证                                   | 结果                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建                                   | TypeScript、Vite、Server、terminal-worker 通过                                                                                                              |
| Node 26 全量单测                       | 167 项：166 通过、1 项 Windows 专用测试跳过                                                                                                                 |
| Node 24 相关回归                       | 21/21，通过默认完全访问、受限审批、隔离和原生回调生命周期                                                                                                   |
| 桌面与移动端审批回归                   | 10/10，通过默认完全访问、批准、拒绝、丢失回执查询、页面刷新、停止取消                                                                                       |
| 新建目标与旧 client 兼容               | 10/10，通过目标、附件、回执恢复，旧 client 不会收到无法识别的权限字段                                                                                       |
| 真实 Chrome + CLI + 加密 Server/client | 只读会话在批准前文件不存在、网络请求为 0；页面批准后写入完成、网络请求 1 次、模型完成回复 1 次                                                              |
| 真实默认完全访问                       | 创建时省略权限字段；未提交任何审批答复，直接写入临时文件并访问本地测试端口各 1 次，模型完成回复 1 次，待审批数 0；CLI 实际返回 `dangerFullAccess` / `never` |

真实只读审批会话：`01a1e19f-1cbb-7143-a42d-668dd289d4a7`。真实默认完全访问会话：`01a1e1aa-8ef2-7032-b4a2-f2bdd97451f2`。均为当前项目下的专用新会话，未对线上工作空间开放其他本机历史。

证据位于本机私有目录 `/private/tmp/cma-1116`：`native-approval-result.json`、`native-full-result.json`、`unit-tests-full.log`、`browser-tests-full.log`、构建日志及 Playwright 截图。目录内还包含临时测试凭据，不可整目录共享。

浏览器回归使用独立 fixture；真实 CLI 验证另通过仅监听 127.0.0.1 的完整 Server/client 执行。测试只向本地接收器取固定文本，并写入专用临时目录；不修改项目文件。

```bash
# 先构建；测试临时目录需先创建，且 MONITOR_TEST_ROOT 只能指向可重建的 fixture。
TMPDIR=/private/tmp/codex-monitor-permissions \
  node --disable-warning=ExperimentalWarning --import tsx --test \
  tests/approvals.test.ts tests/macos-control.test.ts tests/native-lifecycle.test.ts

TMPDIR=/private/tmp/codex-monitor-permissions \
MONITOR_TEST_APPROVALS=1 \
MONITOR_TEST_ROOT=/private/tmp/codex-monitor-permissions/codex-monitor-e2e \
MONITOR_TEST_PORT=14329 \
  npm run test:e2e -- tests/e2e/approvals.spec.ts
```

结构化提问、MCP elicitation 及由桌面原 owner 持有的审批未纳入新的网页审批范围。
