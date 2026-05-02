import type { Cue } from '@/lib/cue';

export function CueDisplay({ cue }: { cue: Cue }) {
  if (cue.kind === 'first') {
    return (
      <div className="rounded-2xl border border-border bg-surface px-5 py-7 text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-faint mb-2">Goal</p>
        <p className="text-2xl font-semibold tracking-tight">Log your first set.</p>
        <p className="text-sm text-muted mt-1.5">No prior data — pick a working weight.</p>
      </div>
    );
  }

  if (cue.kind === 'log_reps') {
    return (
      <div className="relative rounded-2xl border border-primary/40 bg-primary/8 px-5 py-7 text-center overflow-hidden shadow-[0_0_60px_-20px_rgba(34,197,94,0.7)]">
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
        <p className="text-xs uppercase tracking-[0.18em] text-primary-hi mb-3 font-medium">Goal</p>
        <p className="text-4xl font-bold text-text tracking-tight">
          Keep <span className="text-primary-hi tabular-nums">{formatWeight(cue.weight, cue.unit)}</span>
        </p>
        <p className="text-base text-muted mt-2">Log your reps</p>
      </div>
    );
  }

  if (cue.kind === 'keep') {
    return (
      <div className="relative rounded-2xl border border-primary/40 bg-primary/8 px-5 py-7 text-center overflow-hidden shadow-[0_0_60px_-20px_rgba(34,197,94,0.7)]">
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
        <p className="text-xs uppercase tracking-[0.18em] text-primary-hi mb-3 font-medium">Goal</p>
        <p className="text-4xl font-bold text-text tracking-tight">
          Keep <span className="text-primary-hi tabular-nums">{formatWeight(cue.weight, cue.unit)}</span>
        </p>
        <p className="text-base text-muted mt-2">
          Beat <strong className="text-text font-semibold tabular-nums">{cue.repsToBeat}</strong> reps
        </p>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl border border-accent/40 bg-accent/8 px-5 py-7 text-center overflow-hidden shadow-[0_0_60px_-20px_rgba(125,211,252,0.6)]">
      <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
      <p className="text-xs uppercase tracking-[0.18em] text-accent mb-3 font-medium">Goal</p>
      <p className="text-4xl font-bold text-text tracking-tight">
        Beat <span className="text-accent tabular-nums">{formatWeight(cue.weight, cue.unit)}</span>
      </p>
      <p className="text-base text-muted mt-2">
        Hit at least <strong className="text-text font-semibold tabular-nums">{cue.repFloor}</strong> reps
      </p>
    </div>
  );
}

function formatWeight(w: number, unit: string): string {
  const n = Number.isInteger(w) ? w.toString() : w.toFixed(1);
  return unit ? `${n}${unit.toUpperCase()}` : n;
}
