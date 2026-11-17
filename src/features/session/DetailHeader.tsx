import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Download,
  FileDiff,
  Folder,
  Hash,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Search,
  Terminal,
  TerminalSquare,
  X,
} from 'lucide-react';
import { ContextMeter } from '../../context-meter';
import { cx, number } from '../../shared/format';
import { Status } from '../../shared/ui/Status';
import { SessionUsage } from '../usage/SessionUsage';
import { ScreenWakeLockIndicator } from './ScreenWakeLockIndicator';
import { SessionTurnTimer } from './SessionTurnTimer';
import { useSessionActions } from './useSessionActions';
import type { TimelineModel } from './useTimeline';
import { DetailProps } from './useTimeline';

export function DetailHeader({
  page,
  onBack,
  model,
  actions,
  onComputerUse,
  onTerminal,
  onGitDiff,
  creating = false,
}: Pick<DetailProps, 'page' | 'onBack'> & {
  model: Pick<
    TimelineModel,
    | 'session'
    | 'outline'
    | 'setOutline'
    | 'infoExpanded'
    | 'setInfoExpanded'
    | 'toolCount'
    | 'find'
    | 'setFind'
  >;
  actions: ReturnType<typeof useSessionActions>;
  onComputerUse: () => void;
  onTerminal?: () => void;
  onGitDiff?: () => void;
  creating?: boolean;
}) {
  const { session, outline, setOutline, infoExpanded, setInfoExpanded, toolCount, find, setFind } =
    model;
  const { copied, download, exporting } = actions;
  return (
    <>
      <header className="detail-header">
        <button className="icon-button back-button" title="返回会话列表" onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div className="detail-heading">
          <span className="eyebrow">SESSION DETAIL</span>
          <h1 title={session?.title}>{creating ? '新建会话' : session?.title || '读取会话…'}</h1>
          {!creating && <SessionTurnTimer key={session?.id} timing={page?.turnTiming} />}
        </div>
        {!creating && (
          <>
            {onGitDiff && (
              <button
                className="icon-button git-diff-trigger"
                title="查看代码变更"
                aria-label="查看代码变更"
                disabled={!session?.cwd}
                onClick={onGitDiff}
              >
                <FileDiff size={17} />
                <span>变更</span>
              </button>
            )}
            {onTerminal && (
              <button
                className="icon-button project-terminal-trigger"
                title="打开项目终端"
                aria-label="打开项目终端"
                disabled={!session?.cwd}
                onClick={onTerminal}
              >
                <TerminalSquare size={17} />
                <span>终端</span>
              </button>
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
            <button
              className="icon-button"
              title="复制恢复命令"
              disabled={!session}
              onClick={() => void copied(`codex resume ${session!.id}`)}
            >
              <Terminal size={17} />
            </button>
            <button
              className="icon-button"
              title="导出 Markdown"
              disabled={!session || exporting}
              onClick={() => void download()}
            >
              {exporting ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}
            </button>
            <button
              className={cx('icon-button', outline && 'active')}
              title="对话目录"
              aria-expanded={outline}
              aria-controls="conversation-outline"
              onClick={() => setOutline(!outline)}
            >
              <BookOpen size={17} />
            </button>
          </>
        )}
      </header>
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
      {!creating && (
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
              aria-label="搜索会话内容"
              placeholder="查找内容"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
            {find && (
              <button className="icon-button" title="清除内容搜索" onClick={() => setFind('')}>
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
