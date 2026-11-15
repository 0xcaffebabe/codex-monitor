import type { SessionModelSettings } from '../src/types.js';
import type { DesktopControl } from './desktop.js';
import { ControlError } from './control-error.js';

export async function validateModelSettings(
  bridge: Pick<DesktopControl, 'models'>,
  settings: SessionModelSettings,
) {
  if (!settings.model) return;
  const selected = (await bridge.models()).find((option) => option.model === settings.model);
  if (!selected) throw new ControlError('模型不可用，请刷新模型列表。', false, 400);
  if (settings.thinking && !selected.supportedReasoningEfforts.includes(settings.thinking))
    throw new ControlError('此模型不支持所选思考级别，请重新选择。', false, 400);
}
