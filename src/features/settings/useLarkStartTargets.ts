import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { LarkStartSettings } from '../../types';
import type { ManagedWorkspace } from '../../workspaces';
import type { Project } from '../../control-types';

export type LarkStartTargetsOptions = {
  value: LarkStartSettings;
  onChange: (value: LarkStartSettings) => void;
};

export function useLarkStartTargets({ value, onChange }: LarkStartTargetsOptions) {
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
      .then((result) => {
        if (!signal.aborted) setWorkspaces(result.workspaces);
      })
      .catch((error: Error) => {
        if (!signal.aborted) setWorkspaceError(error.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void api<{ projects: Project[]; reason?: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/control`,
      { signal },
    )
      .then((result) => {
        if (signal.aborted) return;
        setProjects(result.projects);
        setProjectError(
          result.reason ?? (result.projects.length ? '' : '此工作空间没有可用项目。'),
        );
      })
      .catch((error: Error) => {
        if (!signal.aborted) setProjectError(error.message);
      });
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
      targets: [
        ...value.targets,
        { alias, workspaceId, projectId, projectName: project.name.slice(0, 500) },
      ],
    });
    setAlias('');
  }
  function remove(alias: string) {
    const targets = value.targets.filter((target) => target.alias !== alias);
    onChange({
      defaultAlias: value.defaultAlias === alias ? (targets[0]?.alias ?? '') : value.defaultAlias,
      targets,
    });
  }
  return {
    workspaces,
    workspaceId,
    projects,
    projectId,
    setProjectId,
    aliasInput,
    setAlias,
    workspaceError,
    projectError,
    duplicate,
    canAdd,
    add,
    remove,
    selectWorkspace: (id: string) => {
      setWorkspaceId(id);
      setProjectId('');
      setProjects([]);
      setProjectError('');
    },
  };
}
