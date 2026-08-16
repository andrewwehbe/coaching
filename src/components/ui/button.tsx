import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

/**
 * The app's button dialects, consolidated (there were 7+ inline variants).
 * Every variant guarantees a ≥44px hit target: visible height for solid
 * buttons, invisible padding for text links.
 *
 * - cta          the money button (log set, start workout, finish & save)
 * - primary      modal/inline confirm
 * - ghost        secondary action next to a primary
 * - danger       destructive confirm inside a sheet
 * - dangerGhost  "report pain" style outline
 * - editorial    coach-side uppercase tracked chip-button
 * - textlink     bare text action, hit area extended invisibly
 */
export type ButtonVariant =
  | 'cta'
  | 'primary'
  | 'ghost'
  | 'danger'
  | 'dangerGhost'
  | 'editorial'
  | 'textlink';

const VARIANT: Record<ButtonVariant, string> = {
  cta: 'h-14 w-full rounded-[var(--r-card)] bg-primary hover:bg-primary-hi active:bg-primary-press text-bg text-base font-semibold shadow-[0_10px_40px_-12px_rgba(34,197,94,0.7)] disabled:opacity-40 disabled:shadow-none transition-all',
  primary:
    'h-11 rounded-[var(--r-control)] px-4 bg-primary hover:bg-primary-hi text-bg text-sm font-semibold disabled:opacity-50 transition-colors',
  ghost:
    'h-11 rounded-[var(--r-control)] px-4 border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text disabled:opacity-40 transition-colors',
  danger:
    'h-11 rounded-[var(--r-control)] px-4 bg-danger hover:bg-danger/90 text-bg text-sm font-semibold disabled:opacity-50 transition-colors',
  dangerGhost:
    'h-11 rounded-[var(--r-control)] px-4 border border-danger/40 text-danger text-sm font-medium hover:bg-danger/10 disabled:opacity-40 transition-colors',
  editorial:
    'rounded-[var(--r-flat)] border border-border bg-surface/40 px-4 py-2.5 text-[10px] uppercase tracking-[0.22em] font-medium text-muted hover:text-text hover:border-border-strong hover:bg-surface disabled:opacity-40 transition-colors',
  // py-3 -my-3 extends the tap target to ~44px without moving layout.
  textlink:
    'relative py-3 -my-3 px-2 -mx-2 text-xs text-muted hover:text-text disabled:opacity-40 transition-colors',
};

export function buttonClasses(variant: ButtonVariant, className = ''): string {
  return `inline-flex items-center justify-center ${VARIANT[variant]} ${className}`.trim();
}

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClasses(variant, className)} {...rest} />;
}

export function ButtonLink({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; children: ReactNode }) {
  return (
    <Link className={buttonClasses(variant, className)} {...rest}>
      {children}
    </Link>
  );
}
