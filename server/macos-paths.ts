import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Only accept bundles that actually contain the Codex runtime, not the ChatGPT app. */
export function macDesktopBundle(configured = process.env.MONITOR_CODEX_DESKTOP) {
  const candidates = configured
    ? [
        configured.includes('.app/')
          ? configured.slice(0, configured.indexOf('.app/') + 4)
          : configured,
      ]
    : [
        ...['/Applications', path.join(os.homedir(), 'Applications')].flatMap((root) =>
          ['Codex.app', 'ChatGPT.app'].map((name) => path.join(root, name)),
        ),
      ];
  return candidates.find((bundle) => !!macBundledCli(bundle));
}

export function macBundledCli(bundle: string) {
  return [
    'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Contents/Resources/codex',
  ]
    .map((relative) => path.join(bundle, relative))
    .find(existsSync);
}
