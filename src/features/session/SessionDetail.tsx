import { Shield, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { cx } from '../../shared/format';
import { MessageComposer } from '../control/MessageComposer';
import { DetailHeader } from './DetailHeader';
import { Outline } from './Outline';
import { Timeline } from './Timeline';
import { useSessionActions } from './useSessionActions';
import { DetailProps, useTimeline } from './useTimeline';
import { ComputerUseTimeline } from './ComputerUseTimeline';
const ProjectTerminal = lazy(() => import('../terminal/ProjectTerminal'));

export function Detail(props: DetailProps & { focusMode?: boolean; onExitFocus?: () => void }) {
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
  } = props;
  const model = useTimeline(props);
  const { outline, setFollow, session } = model;
  const actions = useSessionActions(session, notify);
  const [computerUseSession, setComputerUseSession] = useState('');
  const [terminalSession, setTerminalSession] = useState('');
  useEffect(() => setComputerUseSession(''), [session?.id]);
  useEffect(() => setTerminalSession(''), [session?.id]);
  return (
    <section className="detail-panel" aria-label="会话详情">
      <DetailHeader
        page={page}
        onBack={onBack}
        model={{
          ...model,
          outline: outline && !focusMode,
          setOutline: (visible) => {
            if (visible) onExitFocus?.();
            model.setOutline(visible);
          },
        }}
        actions={actions}
        onComputerUse={() => setComputerUseSession(session?.id ?? '')}
        onTerminal={user.role === 'admin' ? () => setTerminalSession(session?.id ?? '') : undefined}
      />
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
          <Timeline
            page={page}
            loading={loading}
            syncing={syncing}
            error={error}
            connected={connected}
            model={model}
            copied={actions.copied}
          />
          {session && (
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
          )}
        </div>

        {outline && !focusMode && (
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
        <span className="detail-footer-count">已显示 {page?.events.length ?? 0} 条记录</span>
        <Shield size={12} />
      </footer>
    </section>
  );
}
