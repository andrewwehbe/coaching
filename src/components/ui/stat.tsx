import type { ReactNode } from 'react';

/**
 * Eyebrow + display numeral + caption — the coach-home quadrant pattern,
 * extracted so EffortStat/ContextStat/Quadrant stop re-implementing it.
 * The numeral sets in Boska with tabular digits.
 */
export function Stat({
  label,
  value,
  caption,
  tone = 'text',
  size = 'md',
  className = '',
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: 'text' | 'primary' | 'accent' | 'warn' | 'danger' | 'bone';
  size?: 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const toneClass = {
    text: 'text-text',
    primary: 'text-primary-hi',
    accent: 'text-accent',
    warn: 'text-warn',
    danger: 'text-danger',
    bone: 'text-bone',
  }[tone];
  const sizeClass = {
    md: 'text-4xl',
    lg: 'text-6xl',
    xl: 'text-8xl sm:text-9xl',
  }[size];
  return (
    <div className={className}>
      <p className="text-[10px] uppercase tracking-[0.28em] text-faint">{label}</p>
      <p
        className={`font-display leading-[0.9] tracking-tight tabular-nums mt-1 ${sizeClass} ${toneClass}`}
      >
        {value}
      </p>
      {caption && <p className="mt-1.5 text-xs text-muted">{caption}</p>}
    </div>
  );
}
