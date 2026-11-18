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
          <h1>{title}</h1>
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
          <span className="stat-icon" aria-hidden="true">
            <MessageSquare size={19} />
          </span>
          <span>
            全部会话
            <strong>{number(overview?.total ?? 0)}</strong>
          </span>
        </div>
        <button
          className="stat-card live-stat"
          title="筛选进行中的会话"
          onClick={() => changeTab('running')}
        >
          <span className="stat-icon" aria-hidden="true">
            <Activity size={20} />
          </span>
          <span>
            正在进行
            <strong>{number(overview?.running ?? 0)}</strong>
          </span>
        </button>
        <div className="stat-card">
          <span className="stat-icon" aria-hidden="true">
            <Folder size={19} />
          </span>
          <span>
            工作项目
            <strong>{number(overview?.projects.length ?? 0)}</strong>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-icon" aria-hidden="true">
            <Zap size={19} />
          </span>
          <span>
            今日活跃
            <strong>{number(overview?.today ?? 0)}</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
