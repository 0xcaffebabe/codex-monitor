import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../api';
import type { Overview, User } from '../../types';

export type SettingsProps = {
  user: User;
  overview?: Overview;
  onClose: () => void;
  notify: (s: string) => void;
  workspaceAvailable?: boolean;
};
export function useSettings({ user, notify }: SettingsProps) {
  const [devices, setDevices] = useState<
      { id: string; device: string; lastSeen: number; expiresAt: number }[]
    >([]),
    [current, setCurrent] = useState(''),
    [users, setUsers] = useState<User[]>([]),
    [error, setError] = useState(''),
    [pending, setPending] = useState(''),
    [newUser, setNewUser] = useState(''),
    [newPassword, setNewPassword] = useState(''),
    [role, setRole] = useState('viewer'),
    [oldPassword, setOldPassword] = useState(''),
    [password, setPassword] = useState('');
  const load = useCallback(async () => {
    try {
      const d = await api('/api/auth/devices');
      setDevices(d.devices);
      setCurrent(d.current);
      if (user.role === 'admin') setUsers((await api('/api/users')).users);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [user.role]);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(key: string, fn: () => Promise<unknown>) {
    setPending(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending('');
    }
  }
  const revokeDevice = (id: string) =>
    action(id, () => api('/api/auth/devices/' + id, { method: 'DELETE' }));
  const deleteUser = (id: string) =>
    action(id, () => api('/api/users/' + id, { method: 'DELETE' }));
  const changePassword = () =>
    action('password', async () => {
      await post('/api/auth/password', { currentPassword: oldPassword, password });
      setOldPassword('');
      setPassword('');
      notify('密码已更新，其他设备已退出登录');
    });
  const createUser = () =>
    action('create-user', async () => {
      await post('/api/users', { username: newUser, password: newPassword, role });
      setNewUser('');
      setNewPassword('');
      notify('访问账户已创建');
    });
  return {
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
  };
}
