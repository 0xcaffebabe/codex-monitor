import { Pencil, Search, Send, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover } from '../../shared/ui/Popover';
import type { ComposerAction, PromptShortcut } from './prompt-shortcuts';

export function PromptShortcuts({
  shortcuts,
  actions = [],
  disabled,
  canSubmit,
  allowDesktopChannel,
  onSend,
  onInsert,
}: {
  shortcuts: PromptShortcut[];
  actions?: ComposerAction[];
  disabled: boolean;
  canSubmit: boolean;
  allowDesktopChannel: boolean;
  onSend: (shortcut: PromptShortcut) => void;
  onInsert: (shortcut: PromptShortcut) => void;
}) {
  const [query, setQuery] = useState('');
  const results = useRef<HTMLDivElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const filtered = shortcuts.filter(
    (shortcut) =>
      (shortcut.channel !== 'desktop' || allowDesktopChannel) &&
      [shortcut.label, shortcut.description, shortcut.group, ...(shortcut.keywords ?? [])]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search),
  );
  const groups = [...new Set(filtered.map((shortcut) => shortcut.group))];
  const matchingActions = actions.filter((action) =>
    `${action.label} ${action.description} 会话管理`.toLocaleLowerCase().includes(search),
  );
  return (
    <Popover
      label="快捷操作"
      icon={<Zap size={15} />}
      disabled={disabled && !actions.length}
      className="composer-shortcuts-trigger"
      onOpen={() => {
        setQuery('');
        results.current?.scrollTo({ top: 0 });
      }}
    >
      {(close) => (
        <div
          className="composer-shortcuts"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '.shortcut-send:not(:disabled), .shortcut-native-action:not([hidden]) button:not(:disabled)',
              ),
            );
            if (!buttons.length) return;
            event.preventDefault();
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              current < 0
                ? event.key === 'ArrowDown'
                  ? 0
                  : buttons.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                  buttons.length;
            buttons[next].focus();
          }}
        >
          <label className="shortcut-search">
            <Search size={15} />
            <input
              aria-label="搜索快捷操作"
              placeholder="搜索操作，例如提交、桌面…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (
                    !disabled &&
                    filtered.length === 1 &&
                    (canSubmit || filtered[0].channel === 'desktop')
                  ) {
                    close();
                    onSend(filtered[0]);
                  }
                }
              }}
            />
          </label>
          <div className="shortcut-results" ref={results}>
            {groups.map((group) => (
              <section key={group} className="shortcut-group" aria-label={group}>
                <h3>{group}</h3>
                {filtered
                  .filter((shortcut) => shortcut.group === group)
                  .map((shortcut) => (
                    <div className="shortcut-row" key={shortcut.id}>
                      <button
                        type="button"
                        className="shortcut-send"
                        aria-label={shortcut.label}
                        title={`发送提示词：${shortcut.prompt}`}
                        disabled={disabled || (!canSubmit && shortcut.channel !== 'desktop')}
                        onClick={() => {
                          close();
                          onSend(shortcut);
                        }}
                      >
                        <span className="shortcut-icon">{shortcut.icon}</span>
                        <span className="shortcut-copy">
                          <strong>{shortcut.label}</strong>
                          <small>{shortcut.description}</small>
                        </span>
                        <Send size={14} className="shortcut-send-icon" />
                      </button>
                      <button
                        type="button"
                        className="shortcut-insert"
                        aria-label={`填入${shortcut.label}提示词`}
                        title="填入输入框，编辑后发送"
                        disabled={disabled || (!canSubmit && shortcut.channel !== 'desktop')}
                        onClick={() => {
                          close();
                          onInsert(shortcut);
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                  ))}
              </section>
            ))}
            <section
              className="shortcut-group shortcut-native-actions"
              aria-label="会话管理"
              hidden={!matchingActions.length}
            >
              <h3>会话管理</h3>
              {actions.map((action) => (
                <div
                  className="shortcut-native-action"
                  key={action.id}
                  hidden={!matchingActions.includes(action)}
                >
                  {action.render(close)}
                  <small>{action.description}</small>
                </div>
              ))}
            </section>
            {!filtered.length && !matchingActions.length && (
              <p className="shortcut-empty">没有匹配的操作，试试其他关键词。</p>
            )}
          </div>
          <p className="shortcut-footer">
            提示词可直接发送或 <Pencil size={11} /> 先编辑 · ↑↓ 选择
          </p>
        </div>
      )}
    </Popover>
  );
}
