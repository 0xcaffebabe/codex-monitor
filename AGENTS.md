# 协作与架构约定

- 开始前阅读 `docs/architecture.md` 和 `docs/governance/progress.md`；模块所有权与保留契约见 `docs/governance/map.md`。
- 前端按 feature 协作，视图处理展示与事件，领域 hooks 处理请求/持久化/异步状态；纯模型不依赖 React、网络或存储。
- 跨端数据类型放在已有 `src` 顶层契约模块。后端不依赖 `src/features` 或 `src/app`；通用展示不反向依赖业务 feature。迁移后删除旧实现，不添加无调用方转发层。
- 先核实调用者与兼容契约。SQLite/JSONL 读取、原生/桌面 owner/显式旧 pipe、多端通知队列不是可任意合并的同义实现。
- 多 Agent 分工按不重叠文件或模块划分。跨任务修改先协调；禁止覆盖其他人的未提交改动；提交时逐批明确选择文件。
- 构建和浏览器套件使用共享 dist/test-results/playwright-report；同一工作区只允许一个负责人运行它们，其他 Agent 使用约定的验证窗口。完整验证按 build → unit/API → browser 顺序执行，避免输出覆盖和原生进程资源争用。单元套件默认最多两个测试文件并行。
- 使用隔离测试 fixture；不读取私密运行数据做架构扫描，不向真实会话或通知对象发送测试消息，不为重构重启真实服务。
- 每批更新治理进度/任务池；新增关键边界记录决策并纳入机器检查。相关测试通过后，结构调整交付前执行 `npm run check`；明确记录基线失败和未验证的平台。
