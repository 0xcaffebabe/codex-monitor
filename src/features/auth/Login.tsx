import { ArrowRight, KeyRound, LoaderCircle, Radio, Shield, TriangleAlert } from 'lucide-react';
import { Brand } from '../../shared/ui/Brand';
import { LoginProps, useLogin } from './useLogin';

export function Login(props: LoginProps) {
  const { configured } = props;
  const {
    username,
    setUsername,
    password,
    setPassword,
    key,
    setKey,
    remember,
    setRemember,
    error,
    busy,
    submit,
  } = useLogin(props);
  return (
    <div className="login-shell">
      <div className="login-art">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">
            <span className="green-dot" /> YOUR CODEX WORKSPACES
          </span>
          <h1>
            随时掌握
            <br />
            Codex 的工作进展<span>。</span>
          </h1>
          <p>
            从一次提问，到每一步执行。
            <br />
            在电脑或手机上，管理各台机器的工作现场。
          </p>
          <div className="art-terminal">
            <div className="terminal-bar">
              <span />
              <span />
              <span />
              <small>codex · live session</small>
              <Radio size={14} />
            </div>
            <div>
              <span className="terminal-muted">01</span> <span className="terminal-green">❯</span>{' '}
              查看会话的最新进展
              <br />
              <span className="terminal-muted">02</span> <span className="terminal-green">✓</span>{' '}
              工作空间 · 实时双向同步
              <br />
              <span className="terminal-muted">03</span> <span className="terminal-green">↳</span>{' '}
              工具调用 · AI 输出 · 完整历史
              <br />
              <span className="terminal-muted">04</span> <span className="terminal-green">▊</span>
            </div>
          </div>
        </div>
        <span className="login-foot">
          <Shield size={14} /> 私有访问 · 多工作空间集中管理
        </span>
      </div>
      <main className="login-main">
        <div className="login-mobile-brand">
          <Brand />
        </div>
        <form onSubmit={submit} className="login-form">
          <span className="login-icon">
            <KeyRound size={25} />
          </span>
          <span className="eyebrow">CODEX MONITOR</span>
          <h2>{configured ? '连接工作空间' : '创建你的工作空间'}</h2>
          <p>
            {configured
              ? '登录后，即可查看本机 Codex 的全部会话。'
              : '使用本机初始化密钥，创建第一个管理员账户。'}
          </p>
          {!configured && (
            <label>
              初始化密钥
              <input
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="从启动终端或 .monitor/setup-key.txt 获取"
              />
            </label>
          )}
          <label>
            用户名
            <input
              name="username"
              required
              autoComplete="username"
              placeholder="输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            密码
            <input
              name="password"
              required
              minLength={configured ? 1 : 12}
              maxLength={256}
              type="password"
              autoComplete={configured ? 'current-password' : 'new-password'}
              placeholder={configured ? '输入密码' : '设置至少 12 位密码'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住此设备<span>90 天内自动登录</span>
          </label>
          {error && (
            <div className="alert error" role="alert">
              <TriangleAlert size={16} />
              {error}
            </div>
          )}
          <button className="primary login-submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <>
                {configured ? '进入工作空间' : '创建并进入'}
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <div className="login-security">
            <Shield size={15} />
            <span>登录凭据保存在当前浏览器，可随时撤销设备授权。</span>
          </div>
        </form>
        <footer>
          codex-monitor <span>v1.0</span>
        </footer>
      </main>
    </div>
  );
}
