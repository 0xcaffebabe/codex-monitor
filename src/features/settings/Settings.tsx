import { KeyRound, Monitor, Settings2, Shield, Smartphone, X } from 'lucide-react';
import { date, relative } from '../../shared/format';
import { SettingsProps, useSettings } from './useSettings';
import { Notifications } from './Notifications';

export function Settings(props: SettingsProps) {
  const { user, overview, onClose } = props;
  const {
    devices,
    current,
    users,
    error,
    pending,
    newUser,
    setNewUser,
    newPassword,
    setNewPassword,
    role,
    setRole,
    oldPassword,
    setOldPassword,
    password,
    setPassword,
    revokeDevice,
    deleteUser,
    changePassword,
    createUser,
  } = useSettings(props);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <span className="login-icon">
            <Settings2 size={22} />
          </span>
          <div>
            <h2 id="settings-title">设置与访问管理</h2>
            <p>管理工作空间连接、登录设备和访问权限</p>
          </div>
          <button className="icon-button" title="关闭设置" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="settings-body">
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {user.role === 'admin' && props.workspaceAvailable !== false && (
            <Notifications notify={props.notify} />
          )}
          {props.workspaceAvailable !== false && (
            <section>
              <h3>
                <Monitor size={16} />
                本机数据源
              </h3>
              <div className="source-config">
                <span className="green-dot" />
                <strong>{overview?.source.available ? '已连接' : '未连接'}</strong>
                <code>{overview?.source.home}</code>
              </div>
              <p className="help">
                只读访问会话索引和执行记录。数据目录可通过启动配置 CODEX_HOME 修改。
              </p>
            </section>
          )}
          <section>
            <h3>
              <Shield size={16} />
              已授权设备<span>{devices.length}</span>
            </h3>
            <p className="help">每台设备独立授权，有效期 90 天。撤销后，实时连接也会断开。</p>
            {devices.map((d) => (
              <div className="device-row" key={d.id}>
                {d.device.includes('手机') ? <Smartphone size={20} /> : <Monitor size={20} />}
                <div>
                  <strong>
                    {d.device.slice(0, 65)}
                    {d.id === current && <span className="device-current">当前设备</span>}
                  </strong>
                  <small>
                    最近访问 {relative(d.lastSeen)} · {date(d.expiresAt)}到期
                  </small>
                </div>
                {d.id !== current && (
                  <button
                    className="text-danger"
                    disabled={!!pending}
                    onClick={() => void revokeDevice(d.id)}
                  >
                    撤销
                  </button>
                )}
              </div>
            ))}
          </section>
          <section>
            <h3>
              <KeyRound size={16} />
              修改密码
            </h3>
            <form
              className="settings-form"
              onSubmit={(e) => {
                e.preventDefault();
                void changePassword();
              }}
            >
              <label>
                当前密码
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </label>
              <label>
                新密码
                <input
                  type="password"
                  required
                  minLength={12}
                  maxLength={256}
                  autoComplete="new-password"
                  placeholder="至少 12 位"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="secondary" disabled={!!pending}>
                更新密码
              </button>
            </form>
          </section>
          {user.role === 'admin' && (
            <section>
              <h3>
                <KeyRound size={16} />
                访问账户
              </h3>
              <p className="help">
                只读访问者可查看全部会话；管理员还可管理账户。删除账户会立即撤销其全部设备授权。
              </p>
              {users.map((u) => (
                <div className="device-row" key={u.id}>
                  <span className="avatar">{u.username[0].toUpperCase()}</span>
                  <div>
                    <strong>{u.username}</strong>
                    <small>{u.role === 'admin' ? '管理员' : '只读访问者'}</small>
                  </div>
                  {u.id !== user.id && (
                    <button
                      className="text-danger"
                      disabled={!!pending}
                      onClick={() => void deleteUser(u.id)}
                    >
                      删除账户
                    </button>
                  )}
                </div>
              ))}
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createUser();
                }}
              >
                <label>
                  用户名
                  <input
                    value={newUser}
                    required
                    minLength={2}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(e) => setNewUser(e.target.value)}
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    required
                    minLength={12}
                    maxLength={256}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <label>
                  权限
                  <select value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="viewer">只读访问者</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <button className="primary" disabled={!!pending}>
                  创建账户
                </button>
              </form>
            </section>
          )}
        </div>
        <footer>
          <span>
            <Shield size={13} />
            凭据保存在当前浏览器
          </span>
          <button className="secondary" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
