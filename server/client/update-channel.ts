import type { ClientUpdatePhase } from '../../src/workspaces.js';

export type UpdateStatus = { id: string; phase: ClientUpdatePhase; message?: string };

export class ClientUpdateChannel {
  status?: UpdateStatus;
  onStatus?: (status: UpdateStatus) => void;

  constructor() {
    process.on('message', (message: { type?: string; status?: UpdateStatus }) => {
      if (message?.type !== 'update-status' || !message.status) return;
      this.status = message.status;
      this.onStatus?.(message.status);
    });
  }

  start(id: string) {
    if (process.connected) process.send?.({ type: 'update', id });
  }
}
