import { Code2 } from 'lucide-react';

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Code2 size={21} />
      </span>
      <span>
        Codex<span className="brand-light">Monitor</span>
      </span>
    </div>
  );
}
