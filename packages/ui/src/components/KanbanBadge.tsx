'use client';

import { cn } from '../lib/cn';

export type KanbanBadgeProps = {
  name: string;
  color?: string;
  colorClassName?: string;
  className?: string;
};

export const KanbanBadge = ({
  name,
  color,
  colorClassName,
  className,
}: KanbanBadgeProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center',
        'h-5 px-base gap-half',
        'bg-surface-2 rounded-sm',
        'text-sm text-fg-3 font-medium',
        'whitespace-nowrap',
        className
      )}
    >
      {colorClassName ? (
        <span className={cn('w-2 h-2 rounded-full shrink-0', colorClassName)} />
      ) : (
        color && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: `hsl(${color})` }}
          />
        )
      )}
      {name}
    </span>
  );
};
