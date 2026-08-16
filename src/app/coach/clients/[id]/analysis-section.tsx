import { db } from '@/lib/supabase';
import { loadEffortWindow } from '@/lib/effort-window';
import { loadRecommendation } from '@/lib/recommend-for-client';
import type { Recommendation, RecommenderInput } from '@/lib/recommender';
import { Skeleton } from '@/components/skeleton';
import { RecommendationActions } from './recommendation-actions';

/**
 * The heavy half of the client page: effort window (3 queries) + the
 * recommender (~7 stages) + the decisions audit trail. Extracted from
 * page.tsx and rendered behind <Suspense> so the header, actions, and
 * program stream immediately instead of waiting on the analysis engine.
 */
export async function AnalysisSection({ clientId }: { clientId: string }) {
  const supa = db();
  const [effort, recResult, { data: recentDecisions }] = await Promise.all([
    loadEffortWindow(clientId),
    loadRecommendation(clientId),
    // Recent recommendation decisions — audit trail surfaced under the card.
    supa
      .from('recommendations')
      .select('id, created_at, rec_type, title, decision, decision_note')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  return (
    <>
      {recResult && (
        <RecommendationCard
          clientId={clientId}
          rec={recResult.recommendation}
          signals={recResult.signals}
        />
      )}
      <RecentDecisionsSection rows={recentDecisions ?? []} />
      <EffortSection effort={effort} />
    </>
  );
}

export function AnalysisSkeleton() {
  return (
    <div className="mt-4 mb-2 space-y-3" aria-label="Loading analysis">
      <Skeleton className="h-40" />
      <Skeleton className="h-16" />
    </div>
  );
}

function RecommendationCard({
  clientId,
  rec,
  signals,
}: {
  clientId: string;
  rec: Recommendation;
  signals: RecommenderInput;
}) {
  const tone = TONE_FOR_TYPE[rec.type];
  return (
    <section
      aria-label="Recommendation"
      className={`mt-4 mb-2 rounded-md border px-4 py-4 ${tone.container}`}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint">
          Recommendation
        </p>
        <p
          className={`text-[10px] uppercase tracking-[0.22em] font-semibold ${tone.badge}`}
        >
          {LABEL_FOR_TYPE[rec.type]}
        </p>
      </div>
      <h3 className={`font-display text-2xl tracking-tight ${tone.title}`}>
        {rec.title}
      </h3>
      <p className="mt-2 text-sm text-text leading-relaxed">{rec.body}</p>

      {rec.forcedSwaps.length > 0 && (
        <div className="mt-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.22em] text-danger mb-1">
            Forced swap{rec.forcedSwaps.length === 1 ? '' : 's'} · pain
          </p>
          <ul className="text-sm text-danger space-y-0.5">
            {rec.forcedSwaps.map((s) => (
              <li key={s.exerciseId}>{s.exerciseName}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3 group">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.18em] text-faint hover:text-text">
          Why this fired
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted list-disc pl-4">
          {rec.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>

      {rec.dataGaps.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.18em] text-faint hover:text-text">
            Data gaps ({rec.dataGaps.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-faint list-disc pl-4">
            {rec.dataGaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 text-[10px] text-faint italic">
        Practitioner heuristic, not RCT-derived. Override freely.
      </p>

      <RecommendationActions clientId={clientId} rec={rec} signals={signals} />
    </section>
  );
}

type RecentDecisionRow = {
  id: string;
  created_at: string;
  rec_type: string;
  title: string;
  decision: string;
  decision_note: string | null;
};

function RecentDecisionsSection({ rows }: { rows: RecentDecisionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Recent recommendation decisions"
      className="mt-4 mb-2 rounded-md border border-border bg-surface/40 px-4 py-3"
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
        Recent decisions
      </p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-baseline gap-3 text-xs border-b border-border last:border-b-0 pb-2 last:pb-0"
          >
            <span
              className="font-mono tabular-nums text-faint shrink-0"
              title={row.created_at}
            >
              {new Date(row.created_at).toISOString().slice(0, 10)}
            </span>
            <span
              className={
                'text-[10px] uppercase tracking-[0.18em] shrink-0 ' +
                DECISION_TONE[row.decision as keyof typeof DECISION_TONE]
              }
            >
              {row.decision}
            </span>
            <span className="text-text truncate">{row.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DECISION_TONE = {
  applied: 'text-primary-hi',
  acknowledged: 'text-muted',
  snoozed: 'text-warn',
  dismissed: 'text-faint',
} as const;

const LABEL_FOR_TYPE: Record<Recommendation['type'], string> = {
  hold: 'Hold',
  refer_adherence: 'Adherence',
  trigger_deload: 'Deload',
  refer_recovery: 'Recovery',
  phase_transition: 'Phase',
  exercise_reorder: 'Reorder',
  rotate_day: 'Rotate day',
  volume_adjust: 'Volume',
  intensity_adjust: 'Intensity',
  single_exercise_swap: 'Swap',
  refer_technique_or_loading: 'Technique',
  split_rotation: 'Split',
};

const TONE_FOR_TYPE: Record<
  Recommendation['type'],
  { container: string; title: string; badge: string }
> = {
  hold: {
    container: 'border-border bg-surface/40',
    title: 'text-text',
    badge: 'text-muted',
  },
  refer_adherence: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  refer_recovery: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  trigger_deload: {
    container: 'border-accent/40 bg-accent/10',
    title: 'text-accent',
    badge: 'text-accent',
  },
  phase_transition: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  exercise_reorder: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  rotate_day: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  volume_adjust: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  intensity_adjust: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  single_exercise_swap: {
    container: 'border-primary/40 bg-primary/10',
    title: 'text-primary-hi',
    badge: 'text-primary-hi',
  },
  refer_technique_or_loading: {
    container: 'border-warn/40 bg-warn/10',
    title: 'text-warn',
    badge: 'text-warn',
  },
  split_rotation: {
    container: 'border-border bg-surface/40',
    title: 'text-text',
    badge: 'text-muted',
  },
};

function EffortSection({
  effort,
}: {
  effort: {
    windowDays: number;
    avgSessionRpe: number | null;
    sessionRpeSampleCount: number;
    avgSetRir: number | null;
    setRirSampleCount: number;
    rirDrift: number | null;
    rirDriftExerciseCount: number;
  };
}) {
  // Hide entirely when no signal — avoids dead UI for clients who haven't
  // started capturing RIR/sRPE yet.
  if (
    effort.avgSessionRpe == null &&
    effort.avgSetRir == null &&
    effort.rirDrift == null
  )
    return null;

  const driftTone =
    effort.rirDrift != null && effort.rirDrift >= 1
      ? 'warn'
      : effort.rirDrift != null && effort.rirDrift <= -1
        ? 'positive'
        : 'default';
  const driftHint =
    effort.rirDrift == null
      ? null
      : effort.rirDrift >= 1
        ? 'fatigue'
        : effort.rirDrift <= -1
          ? 'easier'
          : 'flat';

  return (
    <section
      aria-label="Effort window"
      className="mt-4 mb-2 rounded-md border border-border bg-surface/40 px-4 py-3"
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-faint mb-2">
        Effort · last {effort.windowDays} days
      </p>
      <dl className="grid grid-cols-3 gap-3 text-xs">
        <EffortStat
          label="Session RPE"
          value={effort.avgSessionRpe != null ? effort.avgSessionRpe.toFixed(1) : '—'}
          sub={`${effort.sessionRpeSampleCount} session${effort.sessionRpeSampleCount === 1 ? '' : 's'}`}
        />
        <EffortStat
          label="Set RIR"
          value={effort.avgSetRir != null ? effort.avgSetRir.toFixed(1) : '—'}
          sub={`${effort.setRirSampleCount} set${effort.setRirSampleCount === 1 ? '' : 's'}`}
        />
        <EffortStat
          label="RIR drift"
          value={
            effort.rirDrift != null
              ? (effort.rirDrift > 0 ? '+' : '') + effort.rirDrift.toFixed(1)
              : '—'
          }
          sub={
            driftHint
              ? `${driftHint} · ${effort.rirDriftExerciseCount}ex`
              : `${effort.rirDriftExerciseCount}ex`
          }
          tone={driftTone}
        />
      </dl>
    </section>
  );
}

function EffortStat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'warn' | 'positive';
}) {
  const valueTone =
    tone === 'warn'
      ? 'text-warn'
      : tone === 'positive'
        ? 'text-primary-hi'
        : 'text-text';
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono tabular-nums text-sm ${valueTone}`}>
        {value}
        <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-faint">
          {sub}
        </span>
      </dd>
    </div>
  );
}
