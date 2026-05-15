import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { buildClientIssues, type ExerciseStatus } from '@/lib/client-issues';
import { ClientHeader } from '../_components/client-header';
import { SuggestionRow } from './suggestion-actions';
import { ApplyAllButton } from './apply-all-button';

export const dynamic = 'force-dynamic';

type Params = Promise<{ clientId: string }>;

export default async function IssuesPage(props: { params: Params }) {
  await requireCoach();
  const { clientId } = await props.params;
  const data = await buildClientIssues(clientId);
  if (!data) notFound();

  const swapsNeedingChoice = data.allSuggestions.filter(
    (s) => s.apply?.kind === 'swap_exercise',
  ).length;

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <ClientHeader
        clientId={data.client.id}
        name={data.client.name}
        weeklyDayTarget={data.client.weeklyDayTarget}
        daysDone={data.daysDoneThisWeek}
        hasIssues={data.hasActionableIssues}
        issueCount={data.issueCount}
        subnav="issues"
      />

      {data.days.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No active program yet — upload one first.
        </p>
      ) : (
        <>
          <ApplyAllButton
            clientId={data.client.id}
            suggestions={data.allSuggestions}
            swapsNeedingChoice={swapsNeedingChoice}
          />

          <div className="space-y-6">
            {data.days.map((d) => (
              <section key={d.id}>
                <h2 className="text-[10px] uppercase tracking-[0.24em] text-faint mb-2">
                  Day {d.dayIndex} — {d.label}
                </h2>
                {d.skippedSuggestion && (
                  <div className="mb-3">
                    <SuggestionRow
                      clientId={data.client.id}
                      suggestion={d.skippedSuggestion}
                    />
                  </div>
                )}
                <ul className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
                  {d.exercises.map((e) => (
                    <li key={e.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-text truncate">{e.name}</p>
                          <p className="mt-0.5 text-[11px] text-faint tabular-nums">
                            {e.prescribedSets ?? '—'} set
                            {e.prescribedSets === 1 ? '' : 's'}
                            {e.prescriptionRaw && (
                              <span className="text-faint/80"> · {e.prescriptionRaw}</span>
                            )}
                          </p>
                        </div>
                        <StatusChip status={e.status} />
                      </div>
                      {e.suggestion && e.suggestion.apply && (
                        <div className="mt-3">
                          <SuggestionRow
                            clientId={data.client.id}
                            suggestion={e.suggestion}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: ExerciseStatus }) {
  const map: Record<ExerciseStatus, { label: string; className: string }> = {
    good: {
      label: 'Good',
      className: 'border-border bg-surface-2 text-muted',
    },
    watch: {
      label: 'Watch',
      className: 'border-warn/35 bg-warn/10 text-warn',
    },
    adjust: {
      label: 'Adjust',
      className: 'border-warn/40 bg-warn/15 text-warn',
    },
    swap_candidate: {
      label: 'Swap',
      className: 'border-danger/35 bg-danger/10 text-danger',
    },
    pain: {
      label: 'Pain',
      className: 'border-danger/40 bg-danger/15 text-danger',
    },
  };
  const cfg = map[status];
  return (
    <span
      className={`shrink-0 inline-flex items-center text-[10px] uppercase tracking-[0.16em] font-medium px-2 py-0.5 rounded-sm border ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}
