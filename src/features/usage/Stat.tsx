import React from 'react';

export function Stat({
  title,
  value,
  note,
  icon,
}: {
  title: string;
  value: string;
  note: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="usage-stat">
      <span>
        {title}
        {icon}
      </span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
