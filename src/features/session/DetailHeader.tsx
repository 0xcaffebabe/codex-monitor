import {
  ArrowLeft,
  Bell,
  BellRing,
  ChevronDown,
  FileDiff,
  Folder,
  Ellipsis,
  GitBranch,
  Hash,
  MessageSquare,
  Monitor,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { ContextMeter } from '../../context-meter';
import { cx, number } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import { Popover } from '../../shared/ui/Popover';
import { SessionUsage } from '../usage/SessionUsage';
import { ScreenWakeLockIndicator } from './ScreenWakeLockIndicator';
import { SessionTurnTimer } from './SessionTurnTimer';
import type { TimelineModel } from './useTimeline';
import { DetailProps } from './useTimeline';

export function DetailHeader({
  page,
  onBack,
  model,
  onComputerUse,
  onTerminal,
  onGitDiff,
  onBranches,
  taskWatch,
  mobileOutline,
  creating = false,
}: Pick<DetailProps, 'page' | 'onBack'> & {
  model: Pick<
    TimelineModel,
    'session' | 'infoExpanded' | 'setInfoExpanded' | 'toolCount' | 'searchText' | 'setFind'
  >;
  onComputerUse: () => void;
  onTerminal?: () => void;
  onGitDiff?: () => void;
  onBranches?: () => void;
  taskWatch?: { watched: boolean; busy: boolean; toggle: () => void };
  mobileOutline?: ReactNode;
  creating?: boolean;
}) {
  const { session, infoExpanded, setInfoExpanded, toolCount, searchText, setFind } = model;
  const search = useRef<HTMLInputElement>(null);
  return (
    <>
      <header className="detail-header">
        <button className="icon-button back-button" title="返回会话列表" onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div className="detail-heading">
          <h1 title={session?.title}>{creating ? '新建会话' : session?.title || '读取会话…'}</h1>
          {!creating && <SessionTurnTimer key={session?.id} timing={page?.turnTiming} />}
        </div>
        {!creating && (
          <>
            {taskWatch && <button className="icon-button" aria-label="关注通知（团队）" title={taskWatch.watched ? '取消关注通知（团队）' : '关注通知（团队）'} aria-pressed={taskWatch.watched} disabled={taskWatch.busy} onClick={taskWatch.toggle}>
              {taskWatch.watched ? <BellRing size={17} /> : <Bell size={17} />}
            </button>}
            {onGitDiff && (
              <button
                className="icon-button git-diff-trigger"
                title="查看工作区变更"
                aria-label="查看工作区变更"
                disabled={!session?.cwd}
                onClick={onGitDiff}
              >
                <FileDiff size={17} />
                <span>变更</span>
              </button>
            )}
            {(onTerminal || onBranches) && (
              <Popover label="项目工具" className="project-tools-trigger" icon={<Ellipsis size={18} />} disabled={!session?.cwd}>
                {(close) => <div className="project-tool-options">
                  {onBranches && <button className="secondary" onClick={() => { close(); onBranches(); }}><GitBranch size={16} />选择 Git 分支</button>}
                  {onTerminal && <button className="secondary" onClick={() => { close(); onTerminal(); }}><TerminalSquare size={16} />打开项目终端</button>}
                </div>}
              </Popover>
            )}
            {page?.hasComputerUse && (
              <button
                className="icon-button computer-use-trigger"
                title="Computer Use 时间线"
                onClick={onComputerUse}
              >
                <Monitor size={18} />
                <span>操作回放</span>
              </button>
            )}
          </>
        )}
      </header>
      {!creating && (
        <div className="detail-toolbar">
          {session && (
            <div className="detail-summary">
              <span className="detail-mobile-status">
                <Status status={session.status} />
              </span>
              <span className="detail-summary-project" title={session.cwd}>
                <Folder size={12} />
                {session.project}
              </span>
              <span className="detail-summary-model" title={session.model || 'Codex'}>
                {session.model || 'Codex'}
              </span>
              <ContextMeter context={page?.context} />
              <button
                className="detail-info-toggle"
                aria-label="会话信息"
                aria-expanded={infoExpanded}
                aria-controls="session-information"
                onClick={() => setInfoExpanded(!infoExpanded)}
              >
                详情
                <ChevronDown size={13} />
              </button>
            </div>
          )}
          <div className="conversation-toolbar">
            <div className="conversation-label">
              <MessageSquare size={14} />
              <span>会话</span>
              {toolCount > 0 && <small>{toolCount} 次调用</small>}
            </div>
            <ScreenWakeLockIndicator />
            <div className="detail-search">
              <Search size={14} />
              <input
                ref={search}
                aria-label="搜索会话内容"
                placeholder="查找内容"
                value={searchText}
                onChange={(e) => setFind(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !searchText) return;
                  event.stopPropagation();
                  setFind('');
                }}
              />
              {searchText && (
                <button
                  className="icon-button"
                  title="清除内容搜索"
                  onClick={() => {
                    setFind('');
                    search.current?.focus();
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {mobileOutline}
          </div>
        </div>
      )}
      <div id="session-information" className={cx('detail-info', infoExpanded && 'expanded')}>
        {session && (
          <>
            <p className="detail-full-title">{session.title}</p>
            <div className="detail-meta">
              <span className="path-chip" title={session.cwd}>
                <Folder size={12} />
                {session.cwd}
              </span>
              <Status status={session.status} />
              <span>{session.model || 'Codex'}</span>
              <span>{number(session.tokens)} tokens</span>
              <span className="detail-id" title={session.id}>
                <Hash size={11} />
                {session.id.slice(0, 8)}
              </span>
            </div>
            <SessionUsage sessionId={session.id} revision={page?.version} />
          </>
        )}
      </div>
    </>
  );
}
