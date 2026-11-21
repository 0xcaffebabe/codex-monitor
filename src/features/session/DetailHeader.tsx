import {
  ArrowLeft,
  Bell,
  BellRing,
  Ellipsis,
  FileDiff,
  Info,
  Monitor,
  TerminalSquare,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Popover } from '../../shared/ui/Popover';
import { Status } from '../../shared/ui/Status';
import type { Session } from '../../types';
import { SessionInformation } from './SessionInformation';
import { SessionTurnTimer } from './SessionTurnTimer';
import type { DetailProps } from './useTimeline';

export function DetailHeader({
  page,
  onBack,
  session,
  onComputerUse,
  onTerminal,
  onGitDiff,
  taskWatch,
  mobileOutline,
  workspaceName,
  creating = false,
}: Pick<DetailProps, 'page' | 'onBack'> & {
  session?: Session;
  onComputerUse: () => void;
  onTerminal?: () => void;
  onGitDiff?: () => void;
  taskWatch?: { watched: boolean; busy: boolean; toggle: () => void };
  mobileOutline?: ReactNode;
  workspaceName?: string;
  creating?: boolean;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const location = [workspaceName, session?.project].filter(Boolean).join(' · ');

  return (
    <header className="detail-header">
      <div className="detail-heading-row">
        <button className="icon-button back-button" title="返回会话列表" onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div className="detail-heading">
          <h1 title={session?.title}>{creating ? '新建会话' : session?.title || '读取会话…'}</h1>
          {!creating && session && (
            <div className="detail-heading-meta">
              <Status status={session.status} />
              {location && (
                <span className="detail-summary-project" title={session.cwd}>
                  {location}
                </span>
              )}
              {page?.turnTiming?.finishedAt === null && (
                <SessionTurnTimer timing={page.turnTiming} />
              )}
            </div>
          )}
        </div>
        {!creating && session && (
          <div className="detail-actions" aria-label="会话操作" role="group">
            {mobileOutline}
            <Popover
              label="更多会话操作"
              className="session-actions-trigger"
              placement="below"
              icon={<Ellipsis size={20} />}
            >
              {(close) => {
                const run = (action: () => void) => () => {
                  close();
                  action();
                };
                return (
                  <div className="session-action-options">
                    <button onClick={run(() => setShowInfo(true))}>
                      <Info size={16} />
                      会话信息
                    </button>
                    {taskWatch && (
                      <button
                        aria-pressed={taskWatch.watched}
                        disabled={taskWatch.busy}
                        onClick={taskWatch.toggle}
                      >
                        {taskWatch.watched ? <BellRing size={16} /> : <Bell size={16} />}
                        关注通知（团队）
                      </button>
                    )}
                    {page?.hasComputerUse && (
                      <button onClick={run(onComputerUse)}>
                        <Monitor size={16} />
                        操作回放
                      </button>
                    )}
                    {session.cwd && (onGitDiff || onTerminal) && (
                      <div className="session-project-actions" role="group" aria-label="项目工具">
                        {onGitDiff && (
                          <button onClick={run(onGitDiff)}>
                            <FileDiff size={16} />
                            查看工作区变更
                          </button>
                        )}
                        {onTerminal && (
                          <button onClick={run(onTerminal)}>
                            <TerminalSquare size={16} />
                            打开项目终端
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              }}
            </Popover>
          </div>
        )}
      </div>
      {showInfo && page && (
        <SessionInformation
          page={page}
          workspaceName={workspaceName}
          onClose={() => setShowInfo(false)}
        />
      )}
    </header>
  );
}
