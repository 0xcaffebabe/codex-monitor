import { useId, useLayoutEffect, useRef } from 'react';
import { UsageDashboard } from './UsageDashboard';

export function UsageDialog({
  workspaceName,
  onSession,
  onClose,
}: {
  workspaceName: string;
  onSession: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="usage-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <UsageDashboard
        onSession={onSession}
        dialogHeading={{ id: titleId, workspaceName, onClose }}
      />
    </dialog>
  );
}
