import { MessageSquare, Shield, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { cx } from '../../shared/format';
import { MessageComposer } from '../control/MessageComposer';
import { NewSessionComposer } from '../control/NewSessionComposer';
import type { NewSessionProps } from '../control/useNewSession';
import { DetailHeader } from './DetailHeader';
import { Outline } from './Outline';
import { Timeline } from './Timeline';
import { useSessionActions } from './useSessionActions';
import { DetailProps, useTimeline } from './useTimeline';
import { ComputerUseTimeline } from './ComputerUseTimeline';
const ProjectTerminal = lazy(() => import('../terminal/ProjectTerminal'));
const GitDiff = lazy(() => import('../git/GitDiff'));

export function Detail(
  props: DetailProps & {
    focusMode?: boolean;
    onExitFocus?: () => void;
    newSession?: Omit<NewSessionProps, 'user'>;
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
    onExitFocus,
    newSession,
  } = props;
  const model = useTimeline(props);
  const { outline, setFollow, session } = model;
  const actions = useSessionActions(session, notify);
  const [computerUseSession, setComputerUseSession] = useState('');
  const [terminalSession, setTerminalSession] = useState('');
  const [gitSession, setGitSession] = useState('');
  useEffect(() => setComputerUseSession(''), [session?.id]);
  useEffect(() => setTerminalSession(''), [session?.id]);
  useEffect(() => setGitSession(''), [session?.id]);
  return (
    <section
      className={cx('detail-panel', !!newSession && 'new-session-detail')}
      aria-label={newSession ? '新建会话' : '会话详情'}
    >
      <DetailHeader
        creating={!!newSession}
        page={page}
        onBack={onBack}
        model={{
          ...model,
          outline: outline && !focusMode && !newSession,
          setOutline: (visible) => {
            if (visible) onExitFocus?.();
            model.setOutline(visible);
          },
        }}
        actions={actions}
        onComputerUse={() => setComputerUseSession(session?.id ?? '')}
        onTerminal={user.role === 'admin' ? () => setTerminalSession(session?.id ?? '') : undefined}
        onGitDiff={user.role === 'admin' ? () => setGitSession(session?.id ?? '') : undefined}
      />
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
            />
          )}
          {newSession && user.role === 'admin' ? (
            <NewSessionComposer user={user} {...newSession} />
          ) : session ? (
            <MessageComposer
              key={session.id}
              user={user}
              threadId={session.id}
              sessionStatus={session.status}
              onAccepted={() => {
                setFollow(true);
                onMessageSent();
              }}
            />
          ) : null}
        </div>

        {outline && !focusMode && !newSession && (
          <>
            <button
              className="outline-backdrop"
              aria-label="关闭对话目录"
              onClick={() => model.setOutline(false)}
            />
            <Outline
              outlineData={outlineData}
              outlineError={outlineError}
              page={page}
              model={model}
            />
          </>
        )}
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
