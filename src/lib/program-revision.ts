import 'server-only';

import { db } from './supabase';
import { log } from './log';

/**
 * Snapshot the current state of a program (days + exercises, ordered)
 * and insert it as the next revision. Used by program/save (reason='edit')
 * and program/commit (reason='sheet_upload') after their primary writes
 * succeed. Idempotent in the sense that re-running won't corrupt past
 * revisions — each call just creates another revision row.
 *
 * Does NOT modify programs/days/exercises. Insert-only into
 * program_revisions.
 *
 * Failure is logged but not propagated — a snapshot failure should never
 * block a successful program edit. The history is best-effort additional
 * context, not load-bearing data.
 */
export async function recordProgramRevision(opts: {
  programId: string;
  editedBy: string | null;
  reason: 'sheet_upload' | 'edit';
}): Promise<void> {
  const supa = db();
  try {
    const { data: days } = await supa
      .from('days')
      .select(
        'id, day_index, label, exercises(id, position, name, name_key, prescription_raw, prescribed_sets, rep_min, rep_max, rir_target, is_cardio, coach_note, muscle_group, archived_at)',
      )
      .eq('program_id', opts.programId)
      .order('day_index');

    type ExRow = {
      id: string;
      position: number;
      name: string;
      name_key: string;
      prescription_raw: string | null;
      prescribed_sets: number | null;
      rep_min: number | null;
      rep_max: number | null;
      rir_target: string | null;
      is_cardio: boolean;
      coach_note: string | null;
      muscle_group: string | null;
      archived_at: string | null;
    };
    type DayRow = {
      id: string;
      day_index: number;
      label: string;
      exercises: ExRow[];
    };

    const snapshot = ((days ?? []) as DayRow[]).map((d) => ({
      day_id: d.id,
      day_index: d.day_index,
      label: d.label,
      exercises: (d.exercises ?? [])
        .slice()
        .sort((a, b) => a.position - b.position),
    }));

    // Next version_number — read max() and add 1. Race-safe enough for the
    // single-coach setting; the (program_id, version_number) unique
    // constraint will reject collisions and we'll log + skip.
    const { data: latest } = await supa
      .from('program_revisions')
      .select('version_number')
      .eq('program_id', opts.programId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (latest?.version_number ?? 0) + 1;

    const { error } = await supa.from('program_revisions').insert({
      program_id: opts.programId,
      version_number: nextVersion,
      edited_by: opts.editedBy,
      reason: opts.reason,
      snapshot,
    });
    if (error) {
      log.warn('program_revision.insert_failed', {
        programId: opts.programId,
        version: nextVersion,
        error: error.message,
      });
    }
  } catch (e) {
    log.warn('program_revision.snapshot_failed', {
      programId: opts.programId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
