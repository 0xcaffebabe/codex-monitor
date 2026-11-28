# 代码结构与职责边界

项目按功能组织前端，按 HTTP、数据读取和控制能力组织后端。入口负责组合依赖；视图负责显示状态和触发操作；请求、持久化及异步状态转换由 hooks 或服务处理。

持续治理记录：[进度](governance/progress.md)、[架构与状态地图](governance/map.md)、[架构决策](governance/decisions.md)、[优化任务池](governance/backlog.md)。

运行时采用 Server / client 架构，详细部署、固定 AES 密钥和故障语义见 [Server / client 说明](server-client.md)。`server/index.ts` 根据模式装配；`server-app.ts` 组合中心 Web、认证、网关和统一通知投递；`client/connection.ts` 建立主动加密 ws 并装配通知事件上报；`workspace-runtime.ts` 在 client 本机装配读取、控制、附件和用量。原 `app.ts` 保留为本机能力测试入口，并将通知采集器和 Server 投递服务直接连接。

## 前端

```text
src/
  main.tsx                 # 挂载 React
  app/                     # 应用装配、主题
  features/
    auth/                  # 登录视图、认证恢复、登录操作
    workspaces/            # client 注册、状态、固定 AES 密钥配置及工作空间选择
    workspace/             # 侧栏、概览、会话列表、筛选与实时同步
    session/               # 详情、时间线、目录、历史读取、导出和图片
    terminal/              # 项目终端弹窗、终端屏幕、输入顺序与输出游标
    git/                   # 会话项目 diff、范围切换、逐行展示和审查请求
    control/               # 消息草稿、回执、队列、命令、目标、新建会话
    attachments/           # 上传、移除、缩略图、项目文件树与文件名搜索
    usage/                 # 用量查询、筛选、指标、图表、请求日志
    settings/              # 设备、密码、访问账户和 Webhook 通知配置
  shared/                  # 通用展示组件、格式化、剪贴板
  api.ts                   # HTTP、认证令牌与 SSE 传输
  workspace-scope.ts       # 文档级工作空间 URL 与草稿范围；切换通过导航取消旧页面请求
  detail-loader.ts         # 串行详情请求、刷新合并与取消
  types.ts                 # 前后端共享的数据契约
  styles/                  # 按 UI 区域和响应式布局拆分的样式
```

每个功能模块中的 `*.tsx` 负责布局、文案、可访问性和事件绑定，`use*.ts` 负责请求、轮询、草稿恢复和状态转换。折叠、输入焦点等展示状态可留在组件中。视图不直接调用 HTTP，也不读写浏览器存储。

关键边界：

| 模块               | 负责的工作                                     | 视图使用方式                  |
| ------------------ | ---------------------------------------------- | ----------------------------- |
| `useSessionList`   | 筛选、分页、保留已加载数量、忽略过期响应       | 消费列表状态，调用 `loadList` |
| `useSessionDetail` | 详情与目录读取、历史合并、定位前补齐历史       | 消费详情，触发加载或定位      |
| `useRealtime`      | SSE 连接、退避重连、定期校准                   | 注入刷新回调，读取连接状态    |
| `useTimeline`      | 阅读位置、自动跟随、历史触发、目录跳转         | 绑定滚动事件，展示时间线模型  |
| `useDesktopLayout` | PC 面板偏好、响应式抽屉与恢复自动布局        | 绑定布局控件和框架状态类      |
| `usePromptForm`    | 草稿与请求 ID 持久化、发送、查询回执、队列取消 | 绑定表单，展示发送状态        |
| `useUsage`         | 用量请求取消、筛选切换、扫描轮询               | 消费查询结果，触发刷新        |

`session-model.ts` 和 `session-list-model.ts` 是不依赖 React、网络或存储的纯函数。历史合并、活动分组和列表分组通过独立测试约束行为。

## 后端

```text
server/
  index.ts                 # 一体、纯 Server、纯 client 启动组合
  cli.ts                   # 启动参数、环境变量覆盖、帮助及启动前配置校验
  config.ts                # 运行配置默认值和范围校验
  server-app.ts            # Server Web、认证和工作空间网关
  workspaces/              # 持久注册、签名握手、请求路由、背压与连接管理
  transport/protocol.ts    # 固定 AES-256-GCM、本次握手绑定、上传/响应分片与协议校验
  client/                  # 连接配置校验、主动 ws、重连、本地临时授权与 loopback HTTP 适配器
  workspace-runtime.ts     # Client 本机能力装配与资源关闭
  image-previews.ts        # AVIF/WebP 尺寸分级、并发与像素上限、源版本缓存和原图回退
  terminal.ts              # 登录设备隔离、目录校验、容量与输出上限、授权复核和终端生命周期
  git.ts                   # 会话目录中的只读 Git 查询、字面路径、文件校验与 diff 大小上限
  project-files.ts         # 已登记项目／会话目录内的文件列表、按文件名递归搜索与读取上限
  terminal-process.ts      # 子进程 IPC 与终止兜底
  terminal-worker.mjs       # 独立进程内的 node-pty；原生 PTY 句柄随进程回收
  desktop-watchdog.ts      # Windows 桌面主进程检查、缺失自动启动、冷却与退出清理
  app.ts                   # 本机能力单元／接口测试入口
  http/
    access.ts              # 身份认证、管理员权限、认证限速
    security.ts            # Host/Origin、响应头、压缩、JSON 限制
    *-routes.ts            # 认证、用户、会话、用量各自的 HTTP 边界
    frontend.ts            # 静态文件、API 404、错误响应
  source.ts                # 会话读取门面，组合各读取器
  source/
    databases.ts           # 只读数据库发现和打开
    session-index.ts       # 元数据缓存、列表查询、概览
    session-files.ts       # 无数据库时的文件索引
    rollouts.ts            # 路径校验、有界 JSONL 读取、解析缓存
    outline.ts             # 对话目录投影与缓存
    images.ts              # 已记录图片的回溯
    computer-use.ts        # 操作时间线、增量索引、截图位置与认证接口的数据读取
    computer-use-parser.ts # Computer Use 识别、返回内容和完整截图解析
    computer-use-log.ts    # 有界 JSONL 字节位置读取，支持部分写入后的增量恢复
    message-images.ts      # 正文图片解析、引用校验与预览标识
    sql.ts                 # 安全的历史字段投影
    completions.ts         # 完成轮次与 JSONL 完成事件读取
    input-requests.ts      # 结构化待答问题、选项、已答过滤与实时记录去重
  notifications/
    lark.ts                # 飞书/Lark 校验、签名、限时 HTTP 投递与业务码检查
    store.ts               # 私有配置、持久化去重、投递队列和历史
    events.ts              # 通知策略、结构化事件和批次契约；不包含接收凭据
    reporter.ts            # Client 后台扫描、已回答问题识别和确认后清理
    report-store.ts        # Client 扫描断点、事件上报日志和待答问题状态
    messages.ts            # Server 统一格式化消息、工作空间及会话链接
    service.ts             # Server 接收去重、统一投递、退避重试和资源关闭
  usage.ts                 # 增量扫描、SQLite 缓存和查询失效策略
  usage-query.ts           # 流式用量汇总、分页结果与时间分桶
```

HTTP 路由依赖其需要的方法集合，例如用量路由只依赖 `sync` 和 `query`，目录读取器只依赖日志读取能力。具体实现由 `createApp` 和会话读取门面组合，不需要通用基类或服务定位器。

认证中间件先于所有受保护路由注册。密码变更与登录共用限速器。退出、权限复核、文件路径限制、请求 ID 去重和资源关闭的处理顺序继续由现有接口测试约束。

## 维护约定

- **SRP**：新增功能放入对应模块；不要向应用入口追加请求、解析或业务状态。
- **OCP**：新增视图、读取适配器或统计展示时，优先在对应功能内扩展，通过现有数据契约与回调接入。
- **LSP / ISP**：实现满足调用方需要的契约；使用窄类型或方法集合，避免要求无关能力。
- **DIP**：在组合入口创建具体适配器；视图通过模型和回调消费能力，路由只使用服务公开的方法。
- 样式统一由 `styles.css` 按顺序导入。移动样式时保留选择器及覆盖顺序；响应式媒体查询可按区域拆开。
- TypeScript 开启未使用变量和参数检查。提交结构调整前运行 `npm run check`，覆盖构建、单元／接口测试及桌面／手机浏览器回归。
- `npm run check:architecture`（也包含在 build 中）解析 src/server 的类型与值依赖，禁止依赖环、浏览器依赖 server、后端依赖 UI、shared 反向依赖 feature/app。顶层契约与两个纯模型的依赖闭包禁止平台能力和外部模块；检查范围及共享产品词汇例外见 [ADR-004](governance/decisions.md)。
