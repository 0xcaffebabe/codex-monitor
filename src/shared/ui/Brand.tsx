import { Code2 } from 'lucide-react';

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Code2 size={21} />
      </span>
      <span>
        codex<span className="brand-light">monitor</span>
        <small>SESSION CONTROL CENTER</small>
      </span>
    </div>
  );
}
