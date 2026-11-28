import { Plus, X } from 'lucide-react';
import { useLarkStartTargets, type LarkStartTargetsOptions } from './useLarkStartTargets';

export function LarkStartTargets({ value, onChange }: LarkStartTargetsOptions) {
  const {
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
    selectWorkspace,
  } = useLarkStartTargets({ value, onChange });
  return (
    <fieldset className="lark-start-targets">
      <legend>Lark 新建会话目标</legend>
      {value.targets.length > 0 && (
        <>
          <label>
            默认目标
            <select
              value={value.defaultAlias}
              onChange={(event) => onChange({ ...value, defaultAlias: event.target.value })}
            >
              {value.targets.map(({ alias }) => (
                <option value={alias} key={alias}>
                  {alias}
                </option>
              ))}
            </select>
          </label>
          <ul>
            {value.targets.map((target) => (
              <li key={target.alias}>
                <code>{target.alias}</code>
                <span>
                  {workspaces.find(({ id }) => id === target.workspaceId)?.name ??
                    target.workspaceId}{' '}
                  / {target.projectName ?? target.projectId}
                </span>
                <button
                  className="icon-button"
                  type="button"
                  title={`移除简称 ${target.alias}`}
                  aria-label={`移除简称 ${target.alias}`}
                  onClick={() => remove(target.alias)}
                >
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
            <select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
              <option value="">选择工作空间</option>
              {workspaces.map(({ id, name, online }) => (
                <option key={id} value={id} disabled={!online}>
                  {name}
                  {online ? '' : '（离线）'}
                </option>
              ))}
            </select>
          </label>
          <label>
            项目
            <select
              value={projectId}
              disabled={!projects.length}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">选择项目</option>
              {projects.map(({ id, name, path }) => (
                <option value={id} key={id}>
                  {name} · {path}
                </option>
              ))}
            </select>
          </label>
          <label>
            简称
            <input
              value={aliasInput}
              autoComplete="off"
              spellCheck={false}
              maxLength={16}
              placeholder="m"
              onChange={(event) => setAlias(event.target.value)}
            />
          </label>
          {(workspaceError || projectError || duplicate) && (
            <p className="help" role="status">
              {workspaceError || projectError || '这个简称已存在。'}
            </p>
          )}
          <button className="secondary" type="button" disabled={!canAdd} onClick={add}>
            <Plus size={14} />
            添加目标
          </button>
        </>
      )}
    </fieldset>
  );
}
