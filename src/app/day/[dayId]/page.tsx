import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { buildCue, type Best, type Cue, type Prescription } from '@/lib/cue';
import { loadBlockBests } from '@/lib/block-best';
import './day-view.css';

export const dynamic = 'force-dynamic';

type Params = Promise<{ dayId: string }>;

export default async function DayViewPage(props: { params: Params }) {
  const { dayId } = await props.params;
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'client') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const supa = db();

  const { data: day } = await supa
    .from('days')
    .select('id, label, program_id')
    .eq('id', dayId)
    .maybeSingle();
  if (!day) notFound();

  // Ownership gate: the day's program must belong to this client. Without this
  // a client could read another client's day by guessing the id.
  const { data: program } = await supa
    .from('programs')
    .select('client_id')
    .eq('id', day.program_id)
    .maybeSingle();
  if (!program || program.client_id !== user.id) notFound();

  const { data: exercises } = await supa
    .from('exercises')
    .select(
      'id, position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, coach_note, is_cardio, muscle_group',
    )
    .eq('day_id', day.id)
    .is('archived_at', null)
    .order('position');

  const list = exercises ?? [];

  // Bests + the client's own notes are keyed by name_key (client-scoped), the
  // same way the live session resolves them — so the preview shows the exact
  // goal the client will see when they start.
  const nameKeys = Array.from(new Set(list.map((e) => e.name_key)));
  const [bests, selfNotes] = nameKeys.length
    ? await Promise.all([
        supa
          .from('best_efforts')
          .select('exercise_name_key, best_weight, best_unit, best_reps')
          .eq('client_id', user.id)
          .in('exercise_name_key', nameKeys)
          .then((r) => r.data ?? []),
        supa
          .from('exercise_self_notes')
          .select('exercise_name_key, note')
          .eq('client_id', user.id)
          .in('exercise_name_key', nameKeys)
          .then((r) => r.data ?? []),
      ])
    : [[], []];
  const bestByKey = new Map(bests.map((b) => [b.exercise_name_key, b]));
  const noteByKey = new Map(selfNotes.map((n) => [n.exercise_name_key, n.note as string]));

  // Same block-scoped cue anchor as the live session, so this preview shows
  // the exact goal the client will see. Falls back to all-time best_efforts.
  const blockBestByKey = await loadBlockBests(supa, user.id, day.program_id, nameKeys);

  const totalSets = list.reduce((n, e) => n + (e.prescribed_sets ?? 0), 0);
  const label = shortLabel(day.label);

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-md w-full mx-auto">
      <header className="dayview-head mb-7">
        <Link
          href="/today"
          prefetch={false}
          className="text-sm text-muted hover:text-text transition-colors"
        >
          ← Today
        </Link>
        <p className="mt-5 text-[11px] uppercase tracking-[0.24em] text-faint">Workout</p>
        <h1 className="font-display text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-1">
          {label}
        </h1>
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-faint tabular-nums">
          {list.length} {list.length === 1 ? 'exercise' : 'exercises'}
          <span className="mx-2 text-border-strong">·</span>
          {totalSets} {totalSets === 1 ? 'set' : 'sets'}
        </p>
      </header>

      {list.length === 0 ? (
        <div className="border-t border-border pt-10 text-center text-muted">
          <p className="font-display text-2xl">Nothing programmed for this day yet.</p>
        </div>
      ) : (
        <ol className="space-y-3">
          {list.map((ex, idx) => {
            const best = bestByKey.get(ex.name_key);
            const bestEffort: Best | null = best
              ? { weight: best.best_weight, unit: best.best_unit, reps: best.best_reps }
              : null;
            const rx: Prescription = {
              setsPrescribed: ex.prescribed_sets,
              repMin: ex.rep_min,
              repMax: ex.rep_max,
            };
            return (
              <li
                key={ex.id}
                className="dayview-card"
                style={{ animationDelay: `${Math.min(idx, 12) * 55}ms` }}
              >
                <ExerciseCard
                  index={ex.position}
                  name={ex.name}
                  prescription={ex.prescription_raw}
                  muscleGroup={ex.muscle_group}
                  isCardio={ex.is_cardio}
                  cue={buildCue(blockBestByKey.get(ex.name_key) ?? bestEffort, rx)}
                  coachNote={ex.coach_note}
                  selfNote={noteByKey.get(ex.name_key) ?? null}
                />
              </li>
            );
          })}
        </ol>
      )}

      <div className="dayview-head mt-8 pt-1" style={{ animationDelay: '160ms' }}>
        <Link
          href="/today"
          prefetch={false}
          className="flex w-full items-center justify-center h-12 rounded-2xl border border-border text-muted text-sm font-medium hover:bg-surface-2 hover:text-text transition-colors"
        >
          Back to today
        </Link>
      </div>
    </main>
  );
}

function ExerciseCard({
  index,
  name,
  prescription,
  muscleGroup,
  isCardio,
  cue,
  coachNote,
  selfNote,
}: {
  index: number;
  name: string;
  prescription: string | null;
  muscleGroup: string | null;
  isCardio: boolean;
  cue: Cue;
  coachNote: string | null;
  selfNote: string | null;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/60 overflow-hidden">
      <div className="flex gap-4 px-4 py-4">
        <span className="font-display text-3xl leading-none text-faint tabular-nums w-9 shrink-0 pt-0.5">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold leading-tight tracking-tight">{name}</h2>
            {isCardio && (
              <span className="shrink-0 mt-0.5 text-[9px] uppercase tracking-[0.18em] text-accent border border-accent/30 bg-accent/8 rounded-full px-2 py-0.5">
                Cardio
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted tabular-nums">
            {prescription ?? '—'}
            {muscleGroup && (
              <>
                <span className="mx-2 text-border-strong">·</span>
                <span className="uppercase tracking-[0.16em] text-[10px] text-faint">
                  {muscleGroup}
                </span>
              </>
            )}
          </p>

          {!isCardio && <CueLine cue={cue} />}

          {coachNote && (
            <p className="mt-3 text-sm text-text border-l-2 border-accent/40 pl-3">
              <span className="block text-[9px] uppercase tracking-[0.18em] text-accent mb-0.5">
                From your coach
              </span>
              {coachNote}
            </p>
          )}
          {selfNote && (
            <p className="mt-2.5 text-sm text-muted border-l-2 border-border pl-3">
              <span className="block text-[9px] uppercase tracking-[0.18em] text-faint mb-0.5">
                Your note
              </span>
              {selfNote}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CueLine({ cue }: { cue: Cue }) {
  const goal = cueGoal(cue);
  return (
    <div className="mt-2.5 flex items-baseline gap-2">
      <span className="text-[9px] uppercase tracking-[0.2em] text-faint shrink-0">Goal</span>
      <span className={`text-sm font-medium ${goal.tone}`}>{goal.text}</span>
    </div>
  );
}

function cueGoal(cue: Cue): { text: string; tone: string } {
  switch (cue.kind) {
    case 'first':
      return { text: 'Log your first set', tone: 'text-muted' };
    case 'log_reps':
      return { text: `Keep ${fmt(cue.weight, cue.unit)} · log your reps`, tone: 'text-primary-hi' };
    case 'keep':
      return {
        text: `Keep ${fmt(cue.weight, cue.unit)} · beat ${cue.repsToBeat} reps`,
        tone: 'text-primary-hi',
      };
    case 'beat':
      return {
        text: `Beat ${fmt(cue.weight, cue.unit)} · ${cue.repFloor}+ reps`,
        tone: 'text-accent',
      };
  }
}

function fmt(w: number, unit: string): string {
  const n = Number.isInteger(w) ? w.toString() : w.toFixed(1);
  return unit ? `${n}${unit.toUpperCase()}` : n;
}

function shortLabel(label: string): string {
  // Match /today: strip the "Day N — " prefix for a cleaner headline.
  const stripped = label.replace(/^Day\s*\d+\s*[—-]\s*/i, '').trim();
  return stripped || label;
}
