import { CircleHelp } from 'lucide-react';

export function Help({ text }: { text: string }) {
  return (
    <span className="usage-help" tabIndex={0} aria-label={text} title={text}>
      <CircleHelp size={12} />
    </span>
  );
}
