import React, { useEffect, useState } from 'react';
import { post, saveToken } from '../../api';
import type { User } from '../../types';

export type LoginProps = {
  configured: boolean;
  onLogin: (u: User) => void;
  notice: string;
};
export function useLogin({ configured, onLogin, notice }: LoginProps) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [key, setKey] = useState(() => new URLSearchParams(location.hash.slice(1)).get('setup') || ''),
    [remember, setRemember] = useState(true),
    [error, setError] = useState(notice),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (location.hash.startsWith('#setup='))
      history.replaceState(history.state, '', location.pathname + location.search);
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        username,
        password,
        device: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? '手机浏览器' : '电脑浏览器',
        ...(!configured ? { setupKey: key } : {}),
      };
      const result = await post('/api/auth/' + (configured ? 'login' : 'setup'), body);
      saveToken(result.token, remember);
      onLogin(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return {
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
  };
}
