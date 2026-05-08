import Link from 'next/link';

export function PageHeader({
  back,
  eyebrow,
  title,
  meta,
  trailing,
}: {
  back?: { href: string; label: string };
  eyebrow?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-6 sm:mb-8">
      {back && (
        <Link
          href={back.href}
          prefetch={false}
          className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
        >
          ← {back.label}
        </Link>
      )}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p
              className={`text-[10px] uppercase tracking-[0.28em] text-faint ${
                back ? 'mt-4' : ''
              }`}
            >
              {eyebrow}
            </p>
          )}
          <h1
            className={`font-display text-4xl sm:text-5xl leading-[0.9] tracking-tight ${
              eyebrow || back ? 'mt-1' : ''
            }`}
          >
            {title}
          </h1>
          {meta && <div className="mt-2 text-xs text-faint">{meta}</div>}
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
    </div>
  );
}

export function Pill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm border text-[10px] uppercase tracking-[0.18em] font-medium transition-colors ${
        active
          ? 'border-primary/60 bg-primary/10 text-primary-hi'
          : 'border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong hover:bg-surface'
      }`}
    >
      {children}
    </Link>
  );
}

export function Chip({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-0.5 rounded-sm border ${className}`}
    >
      {children}
    </span>
  );
}

export function PaginationLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-border text-[10px] uppercase tracking-[0.18em] font-medium text-muted hover:text-text hover:border-primary/50 transition-colors"
    >
      {children}
    </Link>
  );
}
