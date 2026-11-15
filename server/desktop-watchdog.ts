import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const RETRY_MS = 60000;
export type DesktopCheck = 'running' | 'started' | 'missing';

// Read the installed package's identity instead of assuming that its GUI is
// named Codex.exe. Some releases use ChatGPT.exe; resources/codex.exe is a CLI.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $sessionId = (Get-Process -Id $PID).SessionId
  $configured = $env:MONITOR_CODEX_DESKTOP
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Codex\Codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Codex\ChatGPT.exe'),
    (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\Codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\ChatGPT.exe'),
    (Join-Path $env:ProgramFiles 'Codex\Codex.exe')
  )
  function Test-DesktopRunning([string]$exactPath) {
    $processes = Get-CimInstance Win32_Process -Filter "SessionId = $sessionId"
    foreach ($item in $processes) {
      if (!$item.ExecutablePath -or $item.CommandLine -match '(?i)(?:^|\s)--type(?:=|\s)') { continue }
      if ($exactPath) {
        if ([string]::Equals($item.ExecutablePath, $exactPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
      } elseif (
        $item.ExecutablePath -match '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|ChatGPT)\.exe$' -or
        $item.ExecutablePath -in $candidates
      ) { return $true }
    }
    return $false
  }
  if (Test-DesktopRunning $configured) { [Console]::WriteLine('running'); exit 0 }
  if ($env:MONITOR_CODEX_ALLOW_START -ne 'true') { [Console]::WriteLine('missing'); exit 0 }
  $executable = $configured
  $appId = $null
  if (!$executable) {
    foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending)) {
      $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
      $application = $manifest.Package.Applications.Application |
        Where-Object { $_.Executable -match '(?i)(?:^|[\\/])(?:Codex|ChatGPT)\.exe$' } |
        Select-Object -First 1
      if ($application) {
        $executable = Join-Path $package.InstallLocation $application.Executable
        $appId = $package.PackageFamilyName + '!' + $application.Id
        break
      }
    }
    if (!$executable) { $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1 }
  }
  if (!$executable -or !(Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw '找不到 Codex 桌面应用，请先安装，或配置 MONITOR_CODEX_DESKTOP 为桌面程序的完整路径。'
  }
  # Recheck immediately before starting, including paths discovered from a manifest.
  if (Test-DesktopRunning $executable) { [Console]::WriteLine('running'); exit 0 }
  if ($appId) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $appId) -WindowStyle Hidden | Out-Null
  } else {
    Start-Process -FilePath $executable -WorkingDirectory (Split-Path -LiteralPath $executable) -WindowStyle Hidden | Out-Null
  }
  [Console]::WriteLine('started')
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** The helper is hidden; only a missing desktop application is ever launched. */
export async function ensureWindowsDesktop(
  allowStart: boolean,
  executable?: string,
  signal?: AbortSignal,
): Promise<DesktopCheck> {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const { stdout } = await execute(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(windowsScript, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        signal,
        env: {
          ...process.env,
          MONITOR_CODEX_DESKTOP: executable || '',
          MONITOR_CODEX_ALLOW_START: String(allowStart),
        },
      },
    );
    const result = stdout.trim();
    if (result === 'running' || result === 'started' || result === 'missing') return result;
    throw new Error('Codex 桌面状态检查返回了无效结果。');
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim().slice(0, 500) || '无法检查或启动 Codex 桌面应用。');
  }
}

export class DesktopWatchdog {
  private timer: ReturnType<typeof setInterval>;
  private abort = new AbortController();
  private busy?: Promise<void>;
  private stopped = false;
  private nextStartAt = 0;
  private lastNotice = '';
  private ensure: (allowStart: boolean, signal: AbortSignal) => Promise<DesktopCheck>;
  private now: () => number;
  private log: (message: string) => void;

  constructor(
    options: { intervalMs: number; executable?: string },
    dependencies: {
      ensure?: (allowStart: boolean, signal: AbortSignal) => Promise<DesktopCheck>;
      now?: () => number;
      log?: (message: string) => void;
    } = {},
  ) {
    this.ensure =
      dependencies.ensure ??
      ((allow, signal) => ensureWindowsDesktop(allow, options.executable, signal));
    this.now = dependencies.now ?? Date.now;
    this.log = dependencies.log ?? console.log;
    this.timer = setInterval(() => void this.check(), options.intervalMs);
    this.timer.unref();
    this.log(`[Codex desktop] 自动监测已启用，每 ${options.intervalMs / 1000} 秒检查一次。`);
    void this.check();
  }

  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.tick().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private notice(message: string) {
    if (message !== this.lastNotice) this.log('[Codex desktop] ' + message);
    this.lastNotice = message;
  }

  private async tick() {
    try {
      const result = await this.ensure(this.now() >= this.nextStartAt, this.abort.signal);
      if (this.stopped) return;
      if (result === 'started') {
        this.nextStartAt = this.now() + RETRY_MS;
        this.notice('已请求启动桌面应用，等待其就绪；60 秒内不会重复启动。');
      } else {
        this.notice(
          result === 'running' ? '桌面应用运行中。' : '桌面应用未运行，等待下一次启动重试。',
        );
      }
    } catch (error) {
      if (this.stopped) return;
      this.nextStartAt = this.now() + RETRY_MS;
      this.notice(`检查或启动失败，60 秒后可重试：${(error as Error).message}`);
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.busy;
  }
}
