import type { ComponentProps } from 'react';

/**
 * One badge system to replace the three that grew independently
 * (coach Chip, the /today SVG StatusChip, and assorted inline spans).
 * Tones map to what state actually means in this app.
 */
export type BadgeTone =
  | 'done'      // completed / active / positive
  | 'progress'  // in-flight / informational
  | 'neutral'   // dormant / metadata
  | 'warn'      // needs attention
  | 'danger'    // pain / failure
  | 'bone';     // editorial pull-quote accent

const TONE: Record<BadgeTone, string> = {
  done: 'border-primary/50 bg-primary/10 text-primary-hi',
  progress: 'border-accent/40 bg-accent/10 text-accent',
  neutral: 'border-border bg-surface/40 text-muted',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  bone: 'border-bone/30 bg-bone/10 text-bone',
};

export function Badge({
  tone = 'neutral',
  className = '',
  ...rest
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-0.5 rounded-[var(--r-flat)] border ${TONE[tone]} ${className}`.trim()}
      {...rest}
    />
  );
}
