import { ChevronDown, Monitor } from 'lucide-react';
import type { ManagedWorkspace } from '../../workspaces';

export function SessionScope({
  value,
  onChange,
  workspaces,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  workspaces: ManagedWorkspace[];
  label: string;
}) {
  return (
    <label className="session-scope">
      <Monitor size={15} aria-hidden="true" />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部工作空间</option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
            {workspace.online ? '' : '（离线）'}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  );
}
