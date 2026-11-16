import { DesktopBridge, type DesktopControl } from './desktop.js';
import { NativeDesktopControl } from './native-control.js';

export function createDesktopControl(
  options: ConstructorParameters<typeof NativeDesktopControl>[0],
  environment: Pick<NodeJS.Process, 'platform' | 'env'> = process,
): DesktopControl {
  const pipe = environment.env.MONITOR_CODEX_PIPE;
  if (['win32', 'darwin'].includes(environment.platform) && !pipe)
    return new NativeDesktopControl(options);
  return new DesktopBridge({ codexHome: options.codexHome, activity: options.activity, pipe });
}
