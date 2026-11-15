import { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { HOST_RESOURCE_STALE_MS, type ManagedWorkspace } from '../../workspaces';

const percent = (value: number | null | undefined) =>
  value == null ? '—' : `${value.toFixed(1)}%`;
const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);

export function ResourceMetrics({
  workspace,
  compact = false,
  unavailable = false,
}: {
  workspace: ManagedWorkspace;
  compact?: boolean;
  unavailable?: boolean;
}) {
  const { resources } = workspace;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!resources) return;
    // Use Server's sample age; browser and client clocks may differ.
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, HOST_RESOURCE_STALE_MS - resources.ageMs),
    );
    return () => clearTimeout(timer);
  }, [resources]);
  const state = unavailable
    ? '数据不可用'
    : !workspace.online
      ? '离线'
      : !resources
        ? '等待上报'
        : expired || resources.ageMs >= HOST_RESOURCE_STALE_MS
          ? '数据过期'
          : '';
  const current = state ? null : resources;
  const memory = current?.memory;
  const memoryDetail = memory ? `${gib(memory.usedBytes)} / ${gib(memory.totalBytes)} GiB` : '';
  return (
    <div
      className={`host-resources${compact ? ' compact' : ''}${state ? ' muted' : ''}`}
      role="group"
      aria-label={`${workspace.name}整机资源`}
      title={
        state ||
        `整机资源，每 5 秒更新；CPU 为采样期间的平均占用。内存 ${memoryDetail || '暂不可用'}`
      }
    >
      {(!compact || !state) && (
        <>
          <span className="host-resource-metric">
            <Cpu size={14} className="host-resource-icon" aria-hidden="true" />
            <span className="host-resource-label">CPU</span>{' '}
            <strong>{percent(current?.cpuPercent)}</strong>
          </span>
          <span className="host-resource-metric">
            <MemoryStick size={14} className="host-resource-icon" aria-hidden="true" />
            <span className="host-resource-label">内存</span>{' '}
            <strong>{percent(memory?.usedPercent)}</strong>
            {!compact && memoryDetail && <small>{memoryDetail}</small>}
          </span>
        </>
      )}
      {state && (
        <span className="host-resource-state">
          <span className="host-resource-state-dot" aria-hidden="true" />
          {state}
        </span>
      )}
    </div>
  );
}
