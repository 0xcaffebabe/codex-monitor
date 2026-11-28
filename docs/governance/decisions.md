# 架构决策记录

## ADR-001：沿现有功能边界渐进收敛（采纳）

现有系统已有 feature hooks、读取门面、Server/client 分层和行为测试。候选方案：重建目录/统一框架；一次性重写“大文件”；沿现有职责逐批迁移。选择第三种：目录搬迁和框架更换本身不能减少调用方复杂度，还会扩大兼容验证面。

共享契约留在现有 src 顶层契约带，只上提真实跨端的概念。保留有真实调用者的本机测试入口、历史读取器、旧桌面通道和多协议适配器。每批必须删除被替代实现且不能留下无需求的 re-export 兼容层。

Deletion Test：读取门面封装多源合并与缓存，删除会向每条路由扩散复杂性，保留。仅转发一个类型的层没有这种价值，迁移后删除。

## ADR-002：授权规则由独立后端模块拥有（采纳）

问题：control、terminal、git 路由分别查询活跃管理员设备，复核时机存在差异；其他能力为了授权类型依赖整个 control 模块。

候选方案：AuthStore 增加方法（扩张 db-only/ClientAccess 契约）；只共享 SQL（仍复制异步复核时序）；独立授权模块（选择）。模块封装本地复核 → 可选中心复核 → 本地再次复核。HTTP 身份注入和各领域错误响应保留在调用方，关闭检查仍由资源所有者承担。

Deletion Test：删除该模块会将安全规则和 await 后撤权竞争重新扩散到三个执行入口，因此该抽象封装了真实复杂性。

结果：`authorization.ts` 拥有身份/工作空间授权契约和设备复核。新增测试先复现控制请求在远程等待期间被撤权仍执行，再验证修复；还覆盖降权、到期、远程拒绝/异常与关闭期间避免读取已关闭数据库。HTTP、Git、终端、控制保留原领域文案和错误状态。

## ADR-003：共享契约单一所有权（采纳）

问题：前后端重复定义附件、项目、目标/回执，后端通过 feature 目录获取业务类型。

候选方案：后端复用 feature 类型（依赖方向错误）；整体搬至新 shared 树（无必要）；将真正共享的契约归入顶层 attachment/control types（选择）。表单 Draft 等 UI 状态保留 feature 内。迁移所有导入，删除旧同义类型和空转发文件；仅在行为相同的上传边界上共用常量，Lark 专用限制保留独立语义。

Deletion Test：移除权威契约会使服务与 UI 各自维护同一接口；共享类型消除一致性成本，不引入运行时层级。

结果：`attachment-types.ts` 拥有附件与普通上传限制，`control-types.ts` 拥有 Project/SessionGoal/Receipt。删除旧 Attachment、DesktopProject 和 feature 共享类型；Draft 保留 feature。goal 返回类型收紧仅提供编译期保障，未声称替代 RPC 的运行时校验。原有状态 string 保留外部新状态兼容。

## ADR-004：使用已有 TypeScript AST 实施架构约束（采纳）

候选方案：新增 Lint/依赖分析工具链；靠人工约定；使用已有 TypeScript 解析器实现窄范围检查（选择）。检查依赖方向、纯模型边界及类型/运行时环；守卫本身以正反例验证。CI 在原构建与浏览器测试之外运行既有单元/接口套件与架构检查。

约束针对已经确认的职责，不以全局行数上限、随意禁止 feature 协作或统一所有错误类型替代设计。任何例外必须精确到真实模块并说明理由，不允许宽泛忽略目录。

结果：`check:architecture` 纳入 build；CI 增加 npm test。UsageQuery 移入 usage-query，消除唯一类型环。守卫扫描 src/server 的静态可解析依赖，含 import/export/import type/dynamic import/require，检查类型和值依赖环。平台无关性检查覆盖顶层契约、session-model/session-list-model 及其依赖闭包；平台能力名字在这些模块中作为保留名检查，不做任意 JavaScript 副作用的完整证明。`shared/git-commit-shortcuts.ts` 是 Web 与 Lark 共同使用的产品词汇，保留精确例外但同样检查纯依赖闭包。

## ADR-005：图片预览复用 API 二进制传输（采纳）

候选方案：继续复制认证/HTTP 错误；新增 transport facade；复用 apiBlob 并接受可选默认错误文案（选择）。格式探测属于图片模块，须在等待探测前捕获工作空间 URL 与取消信号；实际 HTTP、401、body 读取取消检查由 api 统一负责。

Deletion Test：图片模块的专用复杂性是格式能力探测，不是 HTTP；删除重复传输分支减少复杂性。保留“图片加载失败”默认文案和服务端错误优先级，并防止旧空间的晚到图片或401污染新页面。

## ADR-006：按键串行执行器统一实现、实例按层隔离（采纳）

候选方案：保留两套 Promise 链；共享全局锁或基类；工厂返回独立 keyed executor（选择）。HTTP control 的队列/授权与 NativeDesktopControl 的 writer 生命周期是不同层，不共用锁实例。native serial 继续负责开始执行时的 closed 检查。

Deletion Test：删除 executor 会重新复制失败隔离、尾任务身份比较与清理竞态；该工厂封装真实并发规则。公开接口只有 key + operation；失败只拒绝自身任务，不阻止后继，不串行化不同线程。三条专用行为测试和原控制/队列回归约束顺序与恢复。

## ADR-007：删除不可达概览实现并约束生产可达性（采纳）

全库引用和依赖图确认 OverviewCards 无调用方；其 overview/stat-card 等 exact CSS 类也只用于该组件。选择删除组件及 40 条专属规则，不创建占位层或备用入口；保留正在使用的 running-overview、usage-stat-grid 与公共概览数据。PostCSS 解析验证删除对象，未重排剩余选择器。

守卫从 main.tsx、共享契约和 Web/Lark 产品词汇追踪类型/运行时/dynamic import，拒绝无生产调用方的其他 src 模块。后续新增独立 HTML/worker 等真实入口时须显式更新入口规则；当前没有这类未建模入口。Deletion Test：删除无人调用的 UI 后复杂性直接消失。

## ADR-008：只统一同义词法路径边界（采纳）

候选方案：统一全部文件策略；只共享三处等价 within；保留重复。选择第二种：`path-boundary.ts` 表达允许 root 自身/子路径、拒绝父路径/同前缀兄弟/跨盘；调用者继续拥有 realpath、NOFOLLOW、隐藏文件、私有目录和领域错误。

Uploads 与 RolloutStore 对空 relative 或 '..' 前缀更严格，有真实保护语义，不迁移。图片路径与文件预览对设备名/控制字符的策略也不合并。Deletion Test：删除此谓词会让三处复制包含边界规则；新增层只统一该安全概念，没有吞并各域 IO。

## ADR-009：视图中的异步业务状态按领域 hook 收敛（采纳）

候选方案：所有请求套通用 useQuery；引入外部 query/cache 框架；按现有领域拆出有完整生命周期的 hooks（选择）。审批拥有轮询、单次答复锁、未知回执恢复；设置拥有凭据保存/清空及目标选择；用量拥有取消、筛选/页码联动、日期时区和刷新。

展示展开、焦点和布局保留视图。迁移保留原 DOM、端点、错误/取消/刷新语义并删除原内嵌实现。Deletion Test：删除领域 hook 会重新把联动业务状态散入视图；不为一次简单展示转换建立 hook，不做跨域通用控制器。使用现有真实 Server/client 浏览器测试覆盖行为，不新增实现镜像测试。

## ADR-010：验证资源有界、浏览器产物单写者（采纳）

本机 Node availableParallelism=4，默认测试文件并发3；每文件还启动 esbuild/Git/npm/PowerShell/PTY 子进程。启动器与PTY在同时构建或多套测试时超时，原超时单独复跑通过。选择 npm test 文件并发2，并保持完整 check 阶段顺序；不增加断言超时、不跳过真实平台覆盖。

浏览器套件会清理共享输出，禁止同工作区并行运行。桌面命令用例必须先关闭实际产生的通知再继续点击；仍使用真实点击/可见状态，无force、固定sleep或API拦截。通知布局本身保留为待产品确认。
