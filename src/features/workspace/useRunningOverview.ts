import { useEffect, useMemo, useState } from 'react';
import { taskKey, type RunningTask } from './running-overview-model';

function readTaskOrder(storageKey: string): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(order) ? order.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/** Track panes for this visit while preserving only explicit user reordering across visits. */
export function useRunningOverview(userId: string, running: RunningTask[]) {
  const storageKey = `codex-monitor.overview-order.v1.${userId}`;
  const [trackedTasks, setTrackedTasks] = useState(running);
  const [preferredOrder, setPreferredOrder] = useState(() => readTaskOrder(storageKey));
  const [sortStatus, setSortStatus] = useState('');

  useEffect(() => {
    setTrackedTasks((previous) => {
      const known = new Set(previous.map(taskKey));
      const added = running.filter((task) => !known.has(taskKey(task)));
      return added.length ? [...previous, ...added] : previous;
    });
  }, [running]);

  const tasks = useMemo(() => {
    const rank = new Map(preferredOrder.map((key, index) => [key, index]));
    const position = (task: RunningTask) => rank.get(taskKey(task)) ?? preferredOrder.length;
    return [...trackedTasks].sort((left, right) => position(left) - position(right));
  }, [trackedTasks, preferredOrder]);
  const current = new Map(running.map((item) => [taskKey(item), item]));

  function showTask(task: RunningTask) {
    const key = taskKey(task);
    setTrackedTasks((previous) =>
      previous.some((item) => taskKey(item) === key) ? previous : [...previous, task],
    );
    setPreferredOrder((previous) => [key, ...previous.filter((item) => item !== key)]);
  }

  function dismissTask(key: string) {
    setTrackedTasks((previous) => previous.filter((item) => taskKey(item) !== key));
  }

  function moveTask(source: string, target: string) {
    const order = tasks.map(taskKey);
    const from = order.indexOf(source);
    const to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return false;

    order.splice(from, 1);
    order.splice(to, 0, source);
    setPreferredOrder(order);
    const title = (current.get(source) ?? tasks[from]).session.title;
    setSortStatus(`${title || '会话'}已移动到第 ${to + 1} 位`);
    try {
      localStorage.setItem(storageKey, JSON.stringify(order));
    } catch {
      // Reordering still works during this visit when browser storage is unavailable.
    }
    return true;
  }

  return { tasks, current, sortStatus, showTask, dismissTask, moveTask };
}
