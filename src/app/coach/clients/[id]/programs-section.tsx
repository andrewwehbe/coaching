import Link from 'next/link';
import { format } from 'date-fns';

import { listProgramHistory, getProgramPlan } from '@/lib/program-history';
import { Badge } from '@/components/ui';

/**
 * Program history: every block this client has run, newest first.
 *
 * The active program is badged "Current" and has no end date; past blocks
 * show the window they covered and how many weeks that was. Selecting a row
 * expands the full plan inline — the selection lives in the URL
 * (?program=<id>) so this stays a server component and the coach can link
 * someone straight to a specific block.
 */
export async function ProgramsSection({
  clientId,
  selectedId,
}: {
  clientId: string;
  selectedId: string | null;
}) {
  const history = await listProgramHistory(clientId);

  if (history.length === 0) {
    return (
      <div className="border-t border-border pt-6">
        <p className="text-sm text-muted">No programs yet.</p>
        <Link
          href={`/coach/clients/${clientId}/program`}
          prefetch={false}
          className="mt-3 inline-block text-[11px] uppercase tracking-[0.22em] text-primary-hi hover:text-primary transition-colors border-b border-primary/40 hover:border-primary pb-0.5"
        >
          Upload the first
        </Link>
      </div>
    );
  }

  // Only the expanded row needs its plan loaded.
  const selected = history.find((h) => h.id === selectedId) ?? null;
  const plan = selected ? await getProgramPlan(selected.id) : null;

  return (
    <div className="border-t border-border">
      <ul>
        {history.map((p) => {
          const open = p.id === selectedId;
          const href = open
            ? `/coach/clients/${clientId}?tab=programs`
            : `/coach/clients/${clientId}?tab=programs&program=${p.id}`;
          return (
            <li key={p.id} className="border-b border-border">
              <Link
                href={href}
                prefetch={false}
                scroll={false}
                className="group flex items-start justify-between gap-4 py-4 hover:bg-surface/30 transition-colors px-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.isCurrent ? (
                      <Badge tone="done">Current</Badge>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint tabular-nums">
                        {format(new Date(p.startedAt), 'MMM d, yyyy')}
                        {p.endedAt ? ` – ${format(new Date(p.endedAt), 'MMM d, yyyy')}` : ''}
                      </span>
                    )}
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted tabular-nums">
                      {p.durationWeeks}w{p.isCurrent ? ' so far' : ''}
                    </span>
                  </div>

                  <p className="mt-1.5 text-sm text-text truncate group-hover:text-primary-hi transition-colors">
                    {p.sourceFilename || 'Untitled program'}
                  </p>

                  <p className="mt-1 text-xs text-faint">
                    {p.dayLabels.length > 0 ? p.dayLabels.join(' · ') : 'No days'}
                  </p>

                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint tabular-nums">
                    {p.dayLabels.length} days · {p.exerciseCount} lifts · {p.workoutCount} sessions
                    {p.isCurrent && (
                      <>
                        {' '}
                        · started {format(new Date(p.startedAt), 'MMM d, yyyy')}
                      </>
                    )}
                  </p>
                </div>

                <span
                  aria-hidden
                  className={`shrink-0 mt-1 font-display text-base leading-none text-faint transition-transform ${
                    open ? 'rotate-90' : 'group-hover:translate-x-0.5'
                  }`}
                >
                  →
                </span>
              </Link>

              {open && plan && (
                <div className="pb-5 pl-1 pr-1">
                  {plan.length === 0 ? (
                    <p className="text-sm text-muted">This program has no days.</p>
                  ) : (
                    <div className="space-y-4">
                      {plan.map((d) => (
                        <div key={d.id} className="rounded-[var(--r-card)] border border-border bg-surface/40">
                          <p className="px-4 py-2.5 border-b border-border text-[10px] uppercase tracking-[0.22em] text-faint">
                            {d.label}
                          </p>
                          <ol className="divide-y divide-border">
                            {d.exercises.map((e) => (
                              <li
                                key={e.id}
                                className="px-4 py-2 flex items-baseline justify-between gap-3"
                              >
                                <span className="min-w-0 flex items-baseline gap-2">
                                  <span className="font-mono text-[10px] text-faint tabular-nums shrink-0">
                                    {e.position}
                                  </span>
                                  <span className="text-sm text-text truncate">{e.name}</span>
                                  {e.supersetGroup != null && (
                                    <Badge tone="progress" className="shrink-0">
                                      SS{e.supersetGroup}
                                    </Badge>
                                  )}
                                </span>
                                <span className="font-mono text-xs text-muted tabular-nums shrink-0">
                                  {e.prescriptionRaw || '—'}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
