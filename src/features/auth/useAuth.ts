import { useEffect, useState } from 'react';
import { api, clearToken, currentUser, getToken, post } from '../../api';
import type { User } from '../../types';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [configured, setConfigured] = useState(true),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api<{ configured: boolean }>('/api/auth/status');
        if (alive) setConfigured(s.configured);
        if (getToken()) {
          const u = await currentUser();
          if (alive) setUser(u);
        }
      } catch (e) {
        if (alive) setNotice((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const logout = () => setUser(null);
    const storage = (e: StorageEvent) => {
      if (e.key === 'codex-monitor.auth.v1' && !e.newValue) logout();
    };
    window.addEventListener('monitor:logout', logout);
    window.addEventListener('storage', storage);
    return () => {
      alive = false;
      window.removeEventListener('monitor:logout', logout);
      window.removeEventListener('storage', storage);
    };
  }, []);

  const login = (user: User) => {
    setConfigured(true);
    setNotice('');
    setUser(user);
  };
  const logout = async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      clearToken();
    }
  };
  return { user, loading, configured, notice, login, logout };
}
