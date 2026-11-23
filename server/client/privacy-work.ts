import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const intervalMs = 60_000;
const command = `$ErrorActionPreference = 'Stop'
$sendMessage = Add-Type -MemberDefinition @'
[DllImport("user32.dll")]
public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
'@ -Name Win32SendMessage -Namespace Win32Functions -PassThru
[void]$sendMessage::SendMessage(0xffff, 0x0112, 0xF170, 2)
`;
const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');

async function turnOffWindowsDisplay(signal: AbortSignal) {
  await execute(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    { windowsHide: true, timeout: 15_000, signal },
  );
}

export class PrivacyWork {
  private timer?: ReturnType<typeof setInterval>;
  private active?: AbortController;

  constructor(private turnOffDisplay = turnOffWindowsDisplay) {}

  setEnabled(enabled: boolean, { runImmediately = false } = {}) {
    if (!enabled) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.active?.abort();
    } else if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), intervalMs);
      this.timer.unref();
      if (runImmediately) void this.tick();
    }
  }

  private async tick() {
    if (this.active && !this.active.signal.aborted) return;
    const active = new AbortController();
    this.active = active;
    try {
      await this.turnOffDisplay(active.signal);
    } catch (error) {
      if (!active.signal.aborted) {
        console.warn('隐私工作熄屏失败', error instanceof Error ? error.message : error);
      }
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
