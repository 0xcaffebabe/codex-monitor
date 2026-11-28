# 架构优化任务池

状态：实施中 / 待实施 / 待研究 / 待确认 / 完成。排序按跨调用方一致性、安全性、可验证性与改动局部性，不能仅按文件行数。

| ID | 优先级/状态 | 证据与目标 | 验证/约束 |
| --- | --- | --- | --- |
| A01 | 高 / 实施中 | control、terminal、git 三处活跃管理员 SQL 与远程复核；统一到独立授权模块 | 撤权/过期/异步复核竞争、原错误契约 |
| A02 | 高 / 完成 | Attachment/上传限制与 Project/SessionGoal/Receipt 已统一顶层契约，所有调用方迁移 | 独立复审、TypeScript、39 项行为测试通过 |
| A03 | 高 / 实施中 | usage-query 反向依赖 usage 的类型环；移到真实 owner | 无类型/运行时环、usage suite |
| A04 | 高 / 实施中 | CI 只构建和浏览器测试；无架构守卫 | AST 正负自测、CI 纳入既有 test/边界检查 |
| A05 | 高 / 待实施 | shared/image-preview 复制 API 认证、workspace URL、错误/取消处理 | 统一二进制请求；格式探测和图片错误文案保留 |
| A06 | 中 / 待实施 | control 与 native-control 同义 per-thread promise lane | 单一 keyed executor；保持两层不同实例和串行范围，覆盖失败后继续及键间并发 |
| A07 | 中 / 待实施 | OverviewCards 无入边；核实 CSS/配套 hooks 是否仍使用 | 删除真正不可达实现，不误删复用样式/概览统计 |
| A08 | 高 / 待研究 | ApprovalPanel、Sub2ApiSettings、LarkStartTargets、Sub2ApiUsage、RunningOverview 的 IO/状态进入视图 | 按实际领域 hook 内聚，完成迁移后执行视图边界守卫；不造通用 useQuery |
| A09 | 中 / 待研究 | RunningOverview 多职责、持久化与全局状态、文件预览混合 | 先列生命周期/状态图，再决定哪些需要深模块 |
| A10 | 中 / 待研究 | notifications/service 超过 1000 行，投递/交互编排耦合 | 保留去重、至多重试、不确定发送和 private/group routing 契约 |
| A11 | 中 / 待研究 | 启动器基线集成测试失败 | 独立复跑并定位环境/确定性问题；不放宽断言掩盖失败 |
| A12 | 低 / 待研究 | 主包 Vite 既有大包提示、样式历史覆盖 | 性能/可达性数据支持后才拆分，不做全局格式化 |
| A13 | 中 / 待研究 | 配置与 env 分布于 config/cli/启动器/原生发现 | 区分跨平台入口兼容与真正重复默认值，保留优先级 |
| A14 | 中 / 待研究 | 错误、日志与重试按领域分布 | 识别丢失错误/资源泄漏；不合并语义不同策略 |

## 待确认

暂无需要阻塞其他工作的确认事项。删除显式旧 pipe 支持、变更传输协议版本/外部 API、改变持久状态格式、改变通知或桌面所有权语义均属于需要专门评估的重大变更；本轮不以“降熵”为由直接实施。

## 完成

- G00：建立进度、架构与状态地图、方案决策及任务池；确认初始工作区与依赖/测试基线。
