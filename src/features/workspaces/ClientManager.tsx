import { useState } from 'react';
import { Check, Copy, Monitor, Plus, RefreshCw, X } from 'lucide-react';
import type { WorkspacesModel } from './useWorkspaces';
import {
  clientUpdateInProgress,
  HOST_RESOURCE_STALE_MS,
  type ClientUpdateStatus,
  type ManagedWorkspace,
} from '../../workspaces';
import { relative } from '../../shared/format';
import { ResourceMetrics } from './ResourceMetrics';

const buildTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function BuildTime({ commitAt }: { commitAt?: number | null }) {
  if (commitAt == null) return '未知';
  return <time dateTime={new Date(commitAt).toISOString()}>{buildTime.format(commitAt)}</time>;
}

function formatUptime(seconds: number) {
  if (seconds < 60) return '不足 1 分钟';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return `${days ? `${days} 天 ` : ''}${days || hours ? `${hours} 小时 ` : ''}${minutes} 分钟`;
}

const updateLabels: Record<ClientUpdateStatus['phase'], string> = {
  requested: '等待客户端响应',
  pulling: '正在拉取更新',
  installing: '正在安装依赖',
  building: '正在构建',
  restarting: '正在重启，等待客户端重新连接',
  succeeded: '更新完成',
  failed: '更新失败',
};

function ClientRow({ workspace, model }: { workspace: ManagedWorkspace; model: WorkspacesModel }) {
  const [name, setName] = useState(workspace.name);
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | 'update' | ''>('');
  const update = workspace.clientUpdate;
  const updating = clientUpdateInProgress(update);
  const canUpdate = workspace.online && !!workspace.clientUpdateSupported && !updating;
  const updateTitle = updating
    ? updateLabels[update!.phase]
    : !workspace.online
      ? '客户端离线'
      : !workspace.clientUpdateSupported
        ? '此客户端暂不支持在线更新'
        : '更新并重启';
  const copy = model.connectionCopy?.id === workspace.id ? model.connectionCopy : null;
  const resources = workspace.resources;
  const uptimeSeconds =
    workspace.platform === 'win32' &&
    workspace.online &&
    !model.error &&
    resources &&
    resources.ageMs < HOST_RESOURCE_STALE_MS
      ? resources.uptimeSeconds
      : undefined;
  const privacyWorkEnabled = !!workspace.privacyWorkEnabled;
  const privacyWorkTitle =
    workspace.platform !== 'win32'
      ? '仅支持 Windows'
      : !workspace.online
        ? '客户端离线，连接后可开启隐私工作'
        : !workspace.privacyWorkSupported
          ? '请先更新 Windows 客户端'
          : '开启时立即关闭屏幕，之后每隔 60 秒关闭一次';
  return (
    <article className="client-row">
      <div className="client-heading">
        <Monitor size={20} />
        <strong>{workspace.name}</strong>
        <span title={privacyWorkTitle}>
          <button
            type="button"
            className="client-privacy-switch"
            role="switch"
            aria-checked={privacyWorkEnabled}
            disabled={!!model.pending || (!privacyWorkEnabled && !workspace.privacyWorkSupported)}
            onClick={() => void model.setPrivacyWork(workspace.id, !privacyWorkEnabled)}
          >
            <span className="client-privacy-track" aria-hidden="true" />
            隐私工作
          </button>
        </span>
        {workspace.id !== 'local' && (
          <span className="client-update-action" title={updateTitle}>
            <button
              type="button"
              className="client-update"
              aria-label="更新并重启"
              disabled={!!model.pending || !canUpdate}
              onClick={() => setConfirming('update')}
            >
              <RefreshCw size={14} aria-hidden="true" />
              更新
            </button>
          </span>
        )}
        <span className={`client-status ${workspace.online ? 'client-online' : 'muted'}`}>
          {workspace.online ? '在线' : '离线'}
        </span>
      </div>
      <p className="help client-details">
        <span>
          {workspace.hostname || '等待 client 首次连接'}
          {workspace.platform && ` · ${workspace.platform}`}
        </span>
        <span>
          客户端版本 <BuildTime commitAt={workspace.buildCommitAt} />
        </span>
        {uptimeSeconds !== undefined && <span>开机时长 {formatUptime(uptimeSeconds)}</span>}
        {!workspace.online && workspace.lastSeen && (
          <span>最后连接 {relative(workspace.lastSeen)}</span>
        )}
      </p>
      <ResourceMetrics workspace={workspace} unavailable={!!model.error} />
      <code className="client-id">{workspace.id}</code>
      <div className="client-actions">
        <input
          aria-label={`${workspace.name}的新名称`}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          disabled={!!model.pending || !name.trim() || name.trim() === workspace.name}
          onClick={() => void model.rename(workspace.id, name.trim())}
        >
          保存名称
        </button>
        {workspace.id !== 'local' && (
          <>
            <button
              type="button"
              className="client-copy"
              disabled={!!model.pending}
              onClick={() => void model.copyWorkspaceCommand(workspace.id)}
            >
              {copy?.status === 'copied' ? <Check size={15} /> : <Copy size={15} />}
              <span aria-live="polite">
                {copy?.status === 'copied'
                  ? '已复制'
                  : copy?.status === 'copying'
                    ? '复制中…'
                    : '复制连接命令'}
              </span>
            </button>
            <button disabled={!!model.pending} onClick={() => setConfirming('rotate')}>
              轮换密钥
            </button>
            <button
              className="text-danger"
              disabled={!!model.pending}
              onClick={() => setConfirming('remove')}
            >
              移除
            </button>
          </>
        )}
      </div>
      {copy?.status === 'error' && (
        <p className="alert error" role="alert">
          {copy.message}
        </p>
      )}
      {update && (
        <p className={update.phase === 'failed' ? 'alert error' : 'help'} role="status">
          {update.message || updateLabels[update.phase]}
        </p>
      )}
      {confirming && (
        <div className="client-confirm">
          <span>
            {confirming === 'update'
              ? '更新后客户端将短暂离线。'
              : confirming === 'rotate'
                ? '轮换后当前连接立即断开，需要更新 client 本地密钥。'
                : '移除后此 client 将无法连接，client 本机数据保留。'}
          </span>
          <button
            disabled={!!model.pending || (confirming === 'update' && !canUpdate)}
            onClick={() => {
              void (confirming === 'update'
                ? model.updateClient(workspace.id)
                : confirming === 'rotate'
                  ? model.rotate(workspace.id)
                  : model.remove(workspace.id));
              setConfirming('');
            }}
          >
            确认{confirming === 'update' ? '更新' : confirming === 'rotate' ? '轮换' : '移除'}
          </button>
          <button onClick={() => setConfirming('')}>取消</button>
        </div>
      )}
    </article>
  );
}

export function ClientManager({ model }: { model: WorkspacesModel }) {
  const [confirmingServerUpdate, setConfirmingServerUpdate] = useState(false);
  const serverUpdate = model.serverUpdate;
  const updatingServer = clientUpdateInProgress(serverUpdate);
  const canUpdateServer = model.serverUpdateSupported && !updatingServer && !model.pending;
  return (
    <div className="modal-backdrop" onClick={model.close}>
      <section
        className="settings-modal client-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-manager-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <Monitor size={24} />
          <div>
            <h2 id="client-manager-title">管理工作空间</h2>
            <p className="server-version">
              <span>
                服务端版本 <BuildTime commitAt={model.serverBuildCommitAt} />
              </span>
              {model.serverUpdateSupported && (
                <button
                  type="button"
                  className="client-update"
                  aria-label="更新并重启服务端"
                  disabled={!canUpdateServer}
                  onClick={() => setConfirmingServerUpdate(true)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  更新
                </button>
              )}
            </p>
            <p>一个 client 对应一个工作空间</p>
          </div>
          <button className="icon-button" aria-label="关闭工作空间管理" onClick={model.close}>
            <X size={20} />
          </button>
        </header>
        <div className="settings-body">
          {serverUpdate && (
            <p className={serverUpdate.phase === 'failed' ? 'alert error' : 'help'} role="status">
              {serverUpdate.message ||
                `服务端${serverUpdate.phase === 'requested' ? '等待开始更新' : updateLabels[serverUpdate.phase]}`}
            </p>
          )}
          {confirmingServerUpdate && (
            <div className="client-confirm">
              <span>服务端重启时，网页和客户端连接会短暂中断。</span>
              <button
                type="button"
                disabled={!canUpdateServer}
                onClick={() => {
                  setConfirmingServerUpdate(false);
                  void model.updateServer();
                }}
              >
                确认更新服务端
              </button>
              <button type="button" onClick={() => setConfirmingServerUpdate(false)}>
                取消
              </button>
            </div>
          )}
          {model.error && (
            <div className="alert error" role="alert">
              {model.error}
            </div>
          )}
          <form
            className="client-create"
            onSubmit={(event) => {
              event.preventDefault();
              void model.create();
            }}
          >
            <label htmlFor="new-workspace">添加工作空间</label>
            <div>
              <input
                id="new-workspace"
                placeholder="例如：办公室电脑"
                value={model.name}
                maxLength={80}
                onChange={(event) => model.setName(event.target.value)}
                required
              />
              <button className="primary" disabled={!!model.pending || !model.name.trim()}>
                <Plus size={16} />
                添加
              </button>
            </div>
          </form>
          {model.connectionCommand && (
            <section className="client-config" aria-label="Client 连接命令">
              <h3>client 启动命令</h3>
              <p className="help">
                复制下方命令，在 client 机器的项目目录中运行。固定 AES 密钥只在此显示，请妥善保存。
              </p>
              <textarea
                readOnly
                aria-label="Client 启动命令"
                value={model.connectionCommand}
                rows={5}
                spellCheck={false}
              />
              <button disabled={!!model.pending} onClick={() => void model.copy()}>
                <Copy size={15} />
                {model.copied ? '已复制' : '复制 client 启动命令'}
              </button>
              <p className="help">
                在 client 机器启动应用后，此工作空间将显示在线。关闭此窗口后不再显示密钥。
              </p>
            </section>
          )}
          {model.workspaces.map((workspace) => (
            <ClientRow key={workspace.id} workspace={workspace} model={model} />
          ))}
        </div>
      </section>
    </div>
  );
}
