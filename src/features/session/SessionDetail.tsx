import { MessageSquare, Shield, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { cx } from '../../shared/format';
import { markdownExcerpt } from '../../shared/ui/markdown-excerpt';
import { useMediaQuery } from '../../shared/useMediaQuery';
import { MessageComposer } from '../control/MessageComposer';
import { NewSessionComposer } from '../control/NewSessionComposer';
import type { NewSessionProps } from '../control/useNewSession';
import { DetailHeader } from './DetailHeader';
import { MobileOutline } from './MobileOutline';
import { Outline } from './Outline';
import { Timeline } from './Timeline';
import { useSessionActions } from './useSessionActions';
import { DetailProps, useTimeline } from './useTimeline';
import { ComputerUseTimeline } from './ComputerUseTimeline';
import { ProjectBranchDialog } from '../git/GitBranchSelector';
import type { AttentionRequest, AttentionSession } from '../../attention-types';
import { TurnResult } from './TurnResult';
import { useScreenWakeLock } from './useScreenWakeLock';
const ProjectTerminal = lazy(() => import('../terminal/ProjectTerminal'));
const GitDiff = lazy(() => import('../git/GitDiff'));

export function Detail(
  props: DetailProps & {
    focusMode?: boolean;
    newSession?: Omit<NewSessionProps, 'user'>;
    result?: { turn: string | null; observed: number };
    linkedQuestion?: { workspaceName: string; observed: boolean; current?: AttentionRequest };
    workspaceName?: string;
    activeSessions?: AttentionSession[];
    taskWatch?: { watched: boolean; toggle: () => Promise<void> };
  },
) {
  const {
    user,
    onMessageSent,
    page,
    outlineData,
    outlineError,
    loading,
    syncing,
    error,
    onBack,
    onRetry,
    notify,
    connected,
    focusMode,
    newSession,
  } = props;
  const model = useTimeline(props);
  useScreenWakeLock(!newSession);
  const mobile = useMediaQuery('(max-width: 760px)');
  const { setFollow, session } = model;
  const actions = useSessionActions(notify);
  const [computerUseSession, setComputerUseSession] = useState('');
  const [terminalSession, setTerminalSession] = useState('');
  const [gitSession, setGitSession] = useState('');
  const [branchSession, setBranchSession] = useState('');
  const [savingWatch, setSavingWatch] = useState(false);
  useEffect(() => setComputerUseSession(''), [session?.id]);
  useEffect(() => setTerminalSession(''), [session?.id]);
  useEffect(() => setGitSession(''), [session?.id]);
  useEffect(() => setBranchSession(''), [session?.id]);
  return (
    <section
      className={cx('detail-panel', !!newSession && 'new-session-detail')}
      aria-label={newSession ? '新建会话' : '会话详情'}
    >
      <DetailHeader
        key={session?.id ?? 'empty'}
        creating={!!newSession}
        page={page}
        onBack={onBack}
        workspaceName={props.workspaceName}
        session={session}
        mobileOutline={mobile && !focusMode && !newSession && session && (
          <MobileOutline
            key={session.id}
            outlineData={outlineData}
            outlineError={outlineError}
            page={page}
            model={model}
          />
        )}
        onComputerUse={() => setComputerUseSession(session?.id ?? '')}
        onTerminal={user.role === 'admin' ? () => setTerminalSession(session?.id ?? '') : undefined}
        onGitDiff={user.role === 'admin' ? () => setGitSession(session?.id ?? '') : undefined}
        onBranches={user.role === 'admin' ? () => setBranchSession(session?.id ?? '') : undefined}
        taskWatch={session && props.taskWatch && {
          watched: props.taskWatch.watched,
          busy: savingWatch,
          toggle: async () => {
            if (savingWatch || !props.taskWatch) return;
            setSavingWatch(true);
            try { await props.taskWatch.toggle(); }
            catch (error) { notify((error as Error).message); }
            finally { setSavingWatch(false); }
          },
        }}
      />
      {session && branchSession === session.id && (
        <ProjectBranchDialog session={session} workspaceName={props.workspaceName} activeSessions={props.activeSessions} onClose={() => setBranchSession('')} />
      )}
      {session && gitSession === session.id && (
        <Suspense fallback={null}>
          <GitDiff
            key={session.id}
            session={session}
            user={user}
            onClose={() => setGitSession('')}
            onReviewSent={() => {
              setGitSession('');
              setFollow(true);
              onMessageSent();
              notify('审查请求已发送，请在当前会话中查看结果');
            }}
          />
        </Suspense>
      )}
      {session && terminalSession === session.id && (
        <Suspense fallback={null}>
          <ProjectTerminal
            key={session.id}
            session={session}
            onClose={() => setTerminalSession('')}
          />
        </Suspense>
      )}
      {page && session && computerUseSession === session.id && (
        <ComputerUseTimeline
          key={session.id}
          session={session}
          revision={page.version}
          onClose={() => setComputerUseSession('')}
        />
      )}
      {error && (
        <div className="alert error" role="alert">
          <TriangleAlert size={16} />
          {error}
          <button onClick={onRetry}>重试</button>
        </div>
      )}
      {page?.warnings.map((w) => (
        <div key={w} className="alert warning">
          <TriangleAlert size={14} />
          {w}
        </div>
      ))}
      {page && props.result?.turn && <TurnResult turn={props.result.turn} observed={props.result.observed} page={page} outline={outlineData} error={outlineError} model={model} />}
      {props.linkedQuestion && <section className="turn-result" aria-label="待答复问题">
        <div><h2>待答复问题</h2><p>{props.linkedQuestion.current
          ? [markdownExcerpt(props.linkedQuestion.current.title), `请在 ${props.linkedQuestion.workspaceName} 的 Codex 答复。`].filter(Boolean).join(' · ')
          : props.linkedQuestion.observed ? '该问题不在当前待答复列表中。' : '暂无法确认此问题是否仍需答复。'}</p></div>
      </section>}
      <div className="detail-layout">
        <div className={cx('timeline-column', user.role === 'admin' && 'with-composer')}>
          {newSession ? (
            <div className="timeline-scroll new-session-empty">
              <MessageSquare size={32} strokeWidth={1.3} aria-hidden="true" />
              <h2>开始一个新会话</h2>
              <p>选择工作空间和项目，输入消息或设定目标。</p>
            </div>
          ) : (
            <Timeline
              page={page}
              loading={loading}
              syncing={syncing}
              error={error}
              connected={connected}
              model={model}
              copied={actions.copied}
            >
              {!mobile && !focusMode && (
                <Outline
                  key={session?.id}
                  outlineData={outlineData}
                  outlineError={outlineError}
                  page={page}
                  model={model}
                />
              )}
            </Timeline>
          )}
          {newSession && user.role === 'admin' ? (
            <NewSessionComposer user={user} {...newSession} />
          ) : session ? (
            <MessageComposer
              key={session.id}
              user={user}
              threadId={session.id}
              sessionStatus={session.status}
              context={page?.context}
              onAccepted={() => {
                setFollow(true);
                onMessageSent();
              }}
            />
          ) : null}
        </div>
      </div>
      <footer className="detail-footer">
        <span className={cx('green-dot', !connected && 'offline')} />
        {connected ? '执行记录实时同步' : '连接中断，自动重试中'}
        {!newSession && (
          <span className="detail-footer-count">已显示 {page?.events.length ?? 0} 条记录</span>
        )}
        <Shield size={12} />
      </footer>
    </section>
  );
}
