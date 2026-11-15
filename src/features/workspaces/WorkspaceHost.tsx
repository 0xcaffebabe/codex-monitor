import { LoaderCircle, Monitor, Settings2 } from 'lucide-react';
import { Workspace } from '../workspace/Workspace';
import type { WorkspaceProps } from '../workspace/useWorkspace';
import { useWorkspaces } from './useWorkspaces';
import { ClientManager } from './ClientManager';
import { Brand } from '../../shared/ui/Brand';
import { useState } from 'react';
import { Settings } from '../settings/Settings';
import { ResourceMetrics } from './ResourceMetrics';
import { CompletionNotifications } from '../notifications/CompletionNotifications';

export function WorkspaceHost(props: WorkspaceProps) {
  const model = useWorkspaces();
  const [accessOpen, setAccessOpen] = useState(false);
  const controls = (
    <div className="workspace-selector">
      <div className="workspace-selector-actions">
        <select
          aria-label="切换工作空间"
          value={model.activeId}
          onChange={(event) => model.select(event.target.value)}
        >
          {!model.active && <option value={model.activeId}>选择工作空间</option>}
          {model.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.online ? '●' : '○'} {workspace.name}
              {!workspace.online ? '（离线）' : ''}
            </option>
          ))}
        </select>
        {props.user.role === 'admin' && (
          <button
            className="icon-button"
            title="管理工作空间"
            aria-label="管理工作空间"
            onClick={() => model.setManaging(true)}
          >
            <Settings2 size={17} />
          </button>
        )}
      </div>
      {model.active && (
        <ResourceMetrics workspace={model.active} compact unavailable={!!model.error} />
      )}
    </div>
  );
  return (
    <>
      <CompletionNotifications key={props.user.id} userId={props.user.id} />
      {model.loading ? (
        <div className="full-loader">
          <Brand />
          <LoaderCircle className="spin" />
          <span>连接工作空间…</span>
        </div>
      ) : model.active ? (
        <Workspace
          {...props}
          workspaceName={model.active.name}
          workspaceControls={controls}
          workspaceNotice={
            model.error ||
            (!model.active.online
              ? '此工作空间已离线，正在等待 client 重新连接。已提交操作请在恢复连接后查询原回执。'
              : '')
          }
        />
      ) : (
        <div className="workspace-empty">
          <Brand />
          <Monitor size={38} />
          <h1>{model.activeId ? '工作空间不可用' : '连接你的工作空间'}</h1>
          <p>
            {model.error ||
              (model.activeId
                ? '此工作空间已移除，请切换到其他工作空间。'
                : '添加 client 后，即可在这里集中查看和管理各台机器的 Codex 会话。')}
          </p>
          {controls}
          <button onClick={() => setAccessOpen(true)}>设置与访问管理</button>
          <button onClick={props.onLogout}>退出登录</button>
        </div>
      )}
      {model.managing && <ClientManager model={model} />}
      {accessOpen && (
        <Settings
          user={props.user}
          workspaceAvailable={false}
          onClose={() => setAccessOpen(false)}
          notify={() => {}}
        />
      )}
    </>
  );
}
