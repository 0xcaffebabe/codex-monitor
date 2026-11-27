import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { LarkStartSettings } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import type { Project } from '../control/types';

export function LarkStartTargets({ value, onChange }: {
  value: LarkStartSettings;
  onChange: (value: LarkStartSettings) => void;
}) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [aliasInput, setAlias] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [projectError, setProjectError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api<{ workspaces: ManagedWorkspace[] }>('/api/workspaces', { signal })
      .then((result) => { if (!signal.aborted) setWorkspaces(result.workspaces); })
      .catch((error: Error) => { if (!signal.aborted) setWorkspaceError(error.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void api<{ projects: Project[]; reason?: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/control`,
      { signal },
    ).then((result) => {
      if (signal.aborted) return;
      setProjects(result.projects);
      setProjectError(result.reason ?? (result.projects.length ? '' : '此工作空间没有可用项目。'));
    }).catch((error: Error) => { if (!signal.aborted) setProjectError(error.message); });
    return () => controller.abort();
  }, [workspaceId]);
  const alias = aliasInput.trim().toLowerCase();
  const project = projects.find(({ id }) => id === projectId);
  const duplicate = value.targets.some((target) => target.alias === alias);
  const canAdd = !!project && !duplicate && /^[a-z0-9][a-z0-9_-]{0,15}$/.test(alias);
  function add() {
    if (!canAdd || !project) return;
    onChange({
      defaultAlias: value.defaultAlias || alias,
      targets: [...value.targets, { alias, workspaceId, projectId, projectName: project.name.slice(0, 500) }],
    });
    setAlias('');
  }
  function remove(alias: string) {
    const targets = value.targets.filter((target) => target.alias !== alias);
    onChange({
      defaultAlias: value.defaultAlias === alias ? targets[0]?.alias ?? '' : value.defaultAlias,
      targets,
    });
  }
  return (
    <fieldset className="lark-start-targets">
      <legend>Lark 新建会话目标</legend>
      {value.targets.length > 0 && (
        <>
          <label>
            默认目标
            <select value={value.defaultAlias} onChange={(event) => onChange({ ...value, defaultAlias: event.target.value })}>
              {value.targets.map(({ alias }) => <option value={alias} key={alias}>{alias}</option>)}
            </select>
          </label>
          <ul>
            {value.targets.map((target) => (
              <li key={target.alias}>
                <code>{target.alias}</code>
                <span>{workspaces.find(({ id }) => id === target.workspaceId)?.name ?? target.workspaceId} / {target.projectName ?? target.projectId}</span>
                <button className="icon-button" type="button" title={`移除简称 ${target.alias}`} aria-label={`移除简称 ${target.alias}`} onClick={() => remove(target.alias)}>
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {value.targets.length < 20 && (
        <>
          <label>
            工作空间
            <select value={workspaceId} onChange={(event) => {
              setWorkspaceId(event.target.value);
              setProjectId('');
              setProjects([]);
              setProjectError('');
            }}>
              <option value="">选择工作空间</option>
              {workspaces.map(({ id, name, online }) => (
                <option key={id} value={id} disabled={!online}>{name}{online ? '' : '（离线）'}</option>
              ))}
            </select>
          </label>
          <label>
            项目
            <select value={projectId} disabled={!projects.length} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">选择项目</option>
              {projects.map(({ id, name, path }) => <option value={id} key={id}>{name} · {path}</option>)}
            </select>
          </label>
          <label>
            简称
            <input value={aliasInput} autoComplete="off" spellCheck={false} maxLength={16} placeholder="m" onChange={(event) => setAlias(event.target.value)} />
          </label>
          {(workspaceError || projectError || duplicate) && (
            <p className="help" role="status">{workspaceError || projectError || '这个简称已存在。'}</p>
          )}
          <button className="secondary" type="button" disabled={!canAdd} onClick={add}>
            <Plus size={14} />添加目标
          </button>
        </>
      )}
    </fieldset>
  );
}
