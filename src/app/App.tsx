import { LoaderCircle } from 'lucide-react';
import { Login } from '../features/auth/Login';
import { useAuth } from '../features/auth/useAuth';
import { WorkspaceHost } from '../features/workspaces/WorkspaceHost';
import { Brand } from '../shared/ui/Brand';
import { useTheme } from './useTheme';

export function App() {
  const { user, loading, configured, notice, login, logout } = useAuth();
  const { dark, setDark } = useTheme();
  if (loading)
    return (
      <div className="full-loader">
        <Brand />
        <LoaderCircle className="spin" />
        <span>连接工作空间…</span>
      </div>
    );
  return user ? (
    <WorkspaceHost user={user} onLogout={logout} dark={dark} setDark={setDark} />
  ) : (
    <Login configured={configured} notice={notice} onLogin={login} />
  );
}
