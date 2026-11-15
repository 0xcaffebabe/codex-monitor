import { Activity, Clock, Folder, MessageSquare, Zap } from 'lucide-react';
import { number } from '../../shared/format';
import type { WorkspaceModel } from './useWorkspace';

export function OverviewCards({
  title,
  overview,
  changeTab,
}: Pick<WorkspaceModel, 'title' | 'overview' | 'changeTab'>) {
  return (
    <section className="overview">
      <div className="overview-heading">
        <div>
          <span className="eyebrow">SESSION OBSERVATORY</span>
          <h1 aria-label={title}>
            {title}
            <span className="title-dot" aria-hidden="true">
              .
            </span>
          </h1>
          <p>回顾完整对话，跟进每一步执行。</p>
        </div>
        <div className="today">
          <Clock size={15} />
          {new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'short',
          }).format(Date.now())}
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-icon">
            <MessageSquare size={19} />
          </span>
          <span>
            全部会话
            <strong>
              {number(overview?.total ?? 0)}
              <small>本机历史记录</small>
            </strong>
          </span>
          <span className="stat-decoration">↗</span>
        </div>
        <button className="stat-card live-stat" onClick={() => changeTab('running')}>
          <span className="stat-icon">
            <Activity size={20} />
          </span>
          <span>
            正在进行
            <strong>
              {overview?.running ?? 0}
              <small>
                <span className="green-dot" /> 实时跟进中
              </small>
            </strong>
          </span>
          <span className="mini-bars">▁▃▂▆▄▇▃▅</span>
        </button>
        <div className="stat-card">
          <span className="stat-icon">
            <Folder size={19} />
          </span>
          <span>
            工作项目
            <strong>
              {overview?.projects.length ?? 0}
              <small>跨项目集中查看</small>
            </strong>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-icon">
            <Zap size={19} />
          </span>
          <span>
            今日活跃
            <strong>
              {overview?.today ?? 0}
              <small>按最后活动时间</small>
            </strong>
          </span>
        </div>
      </div>
    </section>
  );
}
