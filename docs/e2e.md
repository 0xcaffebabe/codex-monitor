# 浏览器 E2E

GitHub Actions 在 PR、推送 `main` 和手动触发时，用 Ubuntu 24.04、Node 24 运行架构检查、构建、单元/接口测试和 Playwright Chromium 浏览器回归。浏览器单 worker，不重试；失败时保留 HTML 报告、trace 和截图 7 天。

```bash
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:e2e -- --repeat-each=3
```

全新 Linux 环境把安装浏览器的命令换成 `npx playwright install --with-deps chromium`。无需预先启动服务。可用 `--project=desktop`、`--project=mobile` 或 `--grep` 缩小范围。失败后可用 `npx playwright show-report` 查看报告。

每条用例启动自己的 Server、SQLite/JSONL 数据、临时项目和至少一个真实 Client，监听 `127.0.0.1` 的系统分配端口。Server 使用 `dist/public`，通过真实加密 WebSocket 访问 Client，并以 SSE 向浏览器推送更新。只有 Codex 桌面操作使用测试替身；浏览器不访问外部站点，Webhook 不外发。诊断产物可能含测试生成的临时登录数据，不含真实账户、密钥或会话。

| 测试层 | 覆盖范围 |
| --- | --- |
| Chromium 桌面 | 首次设置、密码登录和会话撤销；归档历史和 Markdown 安全；新建会话和显式审批；跨标签页消息推送、Client 断线恢复；相同会话 ID 的工作空间间草稿、记录和发送隔离 |
| Chromium 手机尺寸 | 触屏进入会话、返回列表和横向溢出检查；不等同于 iOS Safari |
| `npm test` | 协议握手、授权和回执、日志解析、附件和图片预览、通知、项目文件、Git、PTY 和用量等细粒度回归 |
| 真机验证 | macOS 桌面鉴权、原生 owner 控制、iOS Safari Wake Lock／安全区、Windows 原生终端等平台行为 |

旧浏览器套件中的多档尺寸、微交互及各种模拟响应不再逐条运行。新增 E2E 优先覆盖需要浏览器和真实传输共同验证的行为；以可见状态或真实事件推进，不用固定延时，也不拦截本应用的 API 来制造成功响应。

`tests/e2e/pages/` 按账户、工作空间、会话详情和新建会话划分 Page Object。将定位器和页面操作放在对应对象中，用例保留用户旅程、预期断言和传输层验证；服务与数据准备集中在 `tests/e2e/monitor.ts`。
