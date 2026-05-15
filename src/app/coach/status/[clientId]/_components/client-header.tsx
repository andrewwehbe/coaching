import Link from 'next/link';

export function ClientHeader({
  clientId,
  name,
  weeklyDayTarget,
  daysDone,
  hasIssues,
  issueCount,
  subnav,
}: {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  daysDone: number;
  hasIssues: boolean;
  issueCount: number;
  subnav: 'issues' | 'history';
}) {
  const isSunday = new Date().getDay() === 0;
  return (
    <header className="mb-6 sm:mb-8">
      <Link
        href="/coach/status"
        prefetch={false}
        className="inline-flex items-center text-[10px] uppercase tracking-[0.22em] text-faint hover:text-text transition-colors"
      >
        ← All clients
      </Link>
      <div className="mt-4 flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl sm:text-5xl leading-[0.9] tracking-tight">
            {name}
          </h1>
          <p className="mt-2 text-xs text-faint tabular-nums">
            {daysDone}/{weeklyDayTarget} days this week
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2.5 py-1 rounded-sm border ${
            hasIssues
              ? isSunday
                ? 'border-danger/60 bg-danger/15 text-danger animate-pulse'
                : 'border-danger/30 bg-danger/8 text-danger'
              : isSunday
                ? 'border-primary/50 bg-primary/15 text-primary-hi'
                : 'border-border bg-surface-2 text-muted'
          }`}
        >
          {hasIssues ? `Issues (${issueCount})` : 'All set'}
        </span>
      </div>
      <nav className="mt-5 flex gap-2 text-[10px] uppercase tracking-[0.18em]">
        <Link
          href={`/coach/status/${clientId}/issues`}
          prefetch={false}
          className={`px-3 py-1.5 rounded-sm border font-medium transition-colors ${
            subnav === 'issues'
              ? 'border-primary/60 bg-primary/10 text-primary-hi'
              : 'border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
          }`}
        >
          Issues
        </Link>
        <Link
          href={`/coach/status/${clientId}/history`}
          prefetch={false}
          className={`px-3 py-1.5 rounded-sm border font-medium transition-colors ${
            subnav === 'history'
              ? 'border-primary/60 bg-primary/10 text-primary-hi'
              : 'border-border bg-surface/40 text-muted hover:text-text hover:border-border-strong'
          }`}
        >
          History
        </Link>
      </nav>
    </header>
  );
}
