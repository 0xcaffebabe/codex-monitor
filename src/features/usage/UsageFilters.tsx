import { Clock } from 'lucide-react';
import { UsageDashboardModel } from './useUsageDashboard';

export function UsageFilters({
  model: filters,
}: {
  model: Pick<
    UsageDashboardModel,
    | 'range'
    | 'setRange'
    | 'model'
    | 'setModel'
    | 'project'
    | 'setProject'
    | 'subagents'
    | 'setSubagents'
    | 'data'
    | 'projects'
    | 'change'
    | 'from'
    | 'setFrom'
    | 'to'
    | 'setTo'
  >;
}) {
  const {
    range,
    setRange,
    model,
    setModel,
    project,
    setProject,
    subagents,
    setSubagents,
    data,
    projects,
    change,
    from,
    setFrom,
    to,
    setTo,
  } = filters;
  return (
    <>
      {' '}
      <div className="usage-filters">
        <label>
          <Clock size={14} />
          <select
            aria-label="统计时间范围"
            value={range}
            onChange={(e) => change(() => setRange(e.target.value))}
          >
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="all">全部时间</option>
            <option value="custom">自定义日期</option>
          </select>
        </label>
        <label>
          <select
            aria-label="筛选用量模型"
            value={model}
            onChange={(e) => change(() => setModel(e.target.value))}
          >
            <option value="">全部模型</option>
            {(data?.availableModels ?? (model ? [model] : [])).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <select
            aria-label="筛选用量项目"
            value={project}
            onChange={(e) => change(() => setProject(e.target.value))}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="usage-check">
          <input
            type="checkbox"
            checked={subagents}
            onChange={(e) => change(() => setSubagents(e.target.checked))}
          />
          包含子代理
        </label>
        <span className="usage-sync-time">
          {data?.scan.running
            ? `已扫描 ${data.scan.completed} / ${data.scan.files} 个文件`
            : data?.scan.updatedAt
              ? `同步于 ${new Date(data.scan.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              : '等待同步'}
        </span>
      </div>
      {range === 'custom' && (
        <div className="usage-custom-range">
          <label>
            开始日期
            <input
              aria-label="用量开始日期"
              type="date"
              value={from}
              max={to}
              onChange={(e) => change(() => setFrom(e.target.value))}
            />
          </label>
          <span>至</span>
          <label>
            结束日期
            <input
              aria-label="用量结束日期"
              type="date"
              value={to}
              min={from}
              onChange={(e) => change(() => setTo(e.target.value))}
            />
          </label>
        </div>
      )}
    </>
  );
}
