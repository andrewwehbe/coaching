import type { Cue } from '@/lib/cue';

export function CueDisplay({ cue }: { cue: Cue }) {
  if (cue.kind === 'first') {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 px-5 py-6 text-center">
        <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">Goal</p>
        <p className="text-xl font-semibold">Log your first set.</p>
        <p className="text-sm text-neutral-400 mt-1">No prior data — pick a working weight.</p>
      </div>
    );
  }

  if (cue.kind === 'keep') {
    return (
      <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/30 px-5 py-6 text-center">
        <p className="text-xs uppercase tracking-wide text-emerald-300 mb-2">Goal</p>
        <p className="text-3xl font-bold text-emerald-100">
          Keep <span>{formatWeight(cue.weight, cue.unit)}</span>
        </p>
        <p className="text-lg text-emerald-200 mt-1">
          Beat <strong>{cue.repsToBeat}</strong> reps
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-700/40 bg-amber-950/30 px-5 py-6 text-center">
      <p className="text-xs uppercase tracking-wide text-amber-300 mb-2">Goal</p>
      <p className="text-3xl font-bold text-amber-100">
        Beat <span>{formatWeight(cue.weight, cue.unit)}</span>
      </p>
      <p className="text-lg text-amber-200 mt-1">
        Hit at least <strong>{cue.repFloor}</strong> reps
      </p>
    </div>
  );
}

function formatWeight(w: number, unit: string): string {
  const n = Number.isInteger(w) ? w.toString() : w.toFixed(1);
  return unit ? `${n}${unit.toUpperCase()}` : n;
}
