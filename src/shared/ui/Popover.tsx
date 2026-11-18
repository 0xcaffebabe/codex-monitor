import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function Popover({
  label,
  displayLabel = label,
  icon,
  children,
  disabled = false,
  active = false,
  className = '',
  placement = 'above',
  onOpen,
}: {
  label: string;
  displayLabel?: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  placement?: 'above' | 'below';
  onOpen?: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    if (panel.current?.matches(':popover-open')) {
      panel.current.hidePopover();
      if (placement === 'below') trigger.current?.focus({ preventScroll: true });
    }
  };
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const element = panel.current;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
      const below = placement === 'below';
      const left = below ? anchor.right - element.offsetWidth : anchor.left;
      element.style.left = `${Math.max(12, Math.min(left, innerWidth - element.offsetWidth - 12))}px`;
      element.style.top = `${below ? anchor.bottom + 6 : Math.max(12, anchor.top - element.offsetHeight - 8)}px`;
      element.style.setProperty(
        '--popover-bottom',
        `${Math.max(12, innerHeight - (viewport?.height ?? innerHeight) - (viewport?.offsetTop ?? 0) + 12)}px`,
      );
      element.style.setProperty(
        '--popover-height',
        `${Math.min(560, below ? Math.max(0, viewportBottom - anchor.bottom - 18) : (viewport?.height ?? innerHeight) - 24)}px`,
      );
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    const focusTarget = window.matchMedia('(max-width: 760px)').matches
      ? element
      : (element.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)') ??
        element.querySelector<HTMLElement>('button:not(:disabled)'));
    focusTarget?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
    };
  }, [open, placement]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`composer-tool ${className}${active ? ' is-active' : ''}`}
        popoverTarget={id}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-description={displayLabel === label ? undefined : displayLabel}
        title={label}
        disabled={disabled}
      >
        {icon}
        <span className="composer-tool-label">{displayLabel}</span>
        {active && <span className="composer-tool-dot" />}
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role={open ? 'dialog' : undefined}
        aria-label={label}
        className="composer-popover"
        tabIndex={-1}
        onToggle={(event) => {
          const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open';
          setOpen(nextOpen);
          if (nextOpen) onOpen?.();
        }}
      >
        <header className="composer-popover-heading">
          <strong>{label}</strong>
          <button type="button" className="icon-button" aria-label={`关闭${label}`} onClick={close}>
            <X size={16} />
          </button>
        </header>
        {children(close)}
      </div>
    </>
  );
}
