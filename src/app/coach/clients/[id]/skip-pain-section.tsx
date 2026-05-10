import { format, formatDistanceToNow } from 'date-fns';

type SkipPainRow = {
  id: string;
  status: string;
  skip_reason: string | null;
  pain_reason: string | null;
  created_at: string;
  exercises: { name: string } | { name: string }[] | null;
};

function exerciseName(row: SkipPainRow): string {
  const ex = Array.isArray(row.exercises) ? row.exercises[0] : row.exercises;
  return ex?.name ?? 'an exercise';
}

function summarize(row: SkipPainRow): { tone: 'pain' | 'skip'; reason: string | null } {
  if (row.pain_reason || row.status === 'pain') {
    return { tone: 'pain', reason: row.pain_reason ?? row.skip_reason };
  }
  return { tone: 'skip', reason: row.skip_reason };
}

export function SkipPainSection({ rows }: { rows: SkipPainRow[] }) {
  if (rows.length === 0) return null;

  const painCount = rows.filter((r) => summarize(r).tone === 'pain').length;
  const skipCount = rows.length - painCount;

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm uppercase tracking-wide text-faint">
          Recent friction
        </h2>
        <p className="text-xs text-faint tabular-nums">
          {painCount > 0 && (
            <span className="text-warn">
              {painCount} pain
            </span>
          )}
          {painCount > 0 && skipCount > 0 && (
            <span className="text-border-strong mx-1.5">·</span>
          )}
          {skipCount > 0 && <span>{skipCount} skipped</span>}
          <span className="text-border-strong mx-1.5">·</span>
          last 14 days
        </p>
      </div>
      <ul className="rounded-xl border border-border bg-surface/60 divide-y divide-border">
        {rows.map((row) => {
          const { tone, reason } = summarize(row);
          return (
            <li key={row.id} className="px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium truncate">
                  <span
                    className={`text-[10px] uppercase tracking-[0.18em] mr-2 ${
                      tone === 'pain' ? 'text-danger' : 'text-warn'
                    }`}
                  >
                    {tone}
                  </span>
                  {exerciseName(row)}
                </p>
                <p
                  className="text-xs text-faint shrink-0 tabular-nums"
                  title={format(new Date(row.created_at), 'PPpp')}
                >
                  {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                </p>
              </div>
              {reason && (
                <p className="text-xs text-muted mt-1 line-clamp-2">{reason}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
