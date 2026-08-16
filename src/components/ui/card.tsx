import type { ComponentProps } from 'react';

/**
 * Surface dialects, consolidated (there were ~5):
 * - soft     the default client-side card (rounded, faint fill)
 * - raised   slightly stronger fill for stacked/emphasis cards
 * - hairline coach editorial: top hairline, no fill, no radius
 * Tinted tones reproduce the coach-note / deload / warmup / pain cards.
 */
export type CardVariant = 'soft' | 'raised' | 'hairline';
export type CardTone = 'none' | 'accent' | 'warn' | 'danger' | 'primary';

const VARIANT: Record<CardVariant, string> = {
  soft: 'rounded-[var(--r-card)] border border-border bg-surface/40',
  raised: 'rounded-[var(--r-card)] border border-border bg-surface/60',
  hairline: 'border-t border-border',
};

const TONE: Record<Exclude<CardTone, 'none'>, string> = {
  accent: 'rounded-[var(--r-card)] border border-accent/30 bg-accent/8',
  warn: 'rounded-[var(--r-card)] border border-warn/35 bg-warn/10',
  danger: 'rounded-[var(--r-card)] border border-danger/35 bg-danger/10',
  primary: 'rounded-[var(--r-card)] border border-primary/30 bg-primary/8',
};

export function Card({
  variant = 'soft',
  tone = 'none',
  className = '',
  ...rest
}: ComponentProps<'div'> & { variant?: CardVariant; tone?: CardTone }) {
  const skin = tone === 'none' ? VARIANT[variant] : TONE[tone];
  return <div className={`${skin} ${className}`.trim()} {...rest} />;
}

/** The 10px tracked uppercase label that opens most cards. */
export function CardEyebrow({
  className = '',
  ...rest
}: ComponentProps<'p'>) {
  return (
    <p
      className={`text-[10px] uppercase tracking-[0.18em] text-faint ${className}`.trim()}
      {...rest}
    />
  );
}
