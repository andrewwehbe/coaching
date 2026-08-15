import 'server-only';

import { startOfWeek, formatISO, subDays } from 'date-fns';

import { db } from './supabase';
import { buildSuggestionsByClient } from './suggestions';
import type { Suggestion } from './suggestions';

export type ClientStatusRow = {
  clientId: string;
  name: string;
  weeklyDayTarget: number;
  daysDone: number;
  hasActionableIssues: boolean;
  issueCount: number;
  lastActivityAt: string | null;
};

export type StatusOverview = {
  weekStart: string;
  rows: ClientStatusRow[];
};

/**
 * "Actionable" suggestion types — the ones that imply a program change.
 * Watch and adherence are informational and do NOT trigger the Issues badge.
 */
const ACTIONABLE_TYPES: ReadonlySet<Suggestion['type']> = new Set([
  'adjust',
  'swap_candidate',
  'pain',
  'skipped_day',
]);

/**
 * Pure: given the list of suggestion types attached to a client, return
 * whether the Issues badge should fire and how many actionable items.
 * Exported for unit tests.
 */
export function classifyClientStatus(types: string[]): {
  hasActionableIssues: boolean;
  issueCount: number;
} {
  let issueCount = 0;
  for (const t of types) {
    if (ACTIONABLE_TYPES.has(t as Suggestion['type'])) issueCount++;
  }
  return { hasActionableIssues: issueCount > 0, issueCount };
}

/**
 * Builds the cards-grid overview for /coach/status. One row per active
 * client. Follows the batched-query pattern from lib/weekly-report.ts —
 * never per-client loops.
 */
export async function buildStatusOverview(at: Date = new Date()): Promise<StatusOverview> {
  const supa = db();
  const weekStart = startOfWeek(at, { weekStartsOn: 1 });
  const weekStartIso = formatISO(weekStart, { representation: 'date' });

  const { data: clients } = await supa
    .from('clients')
    .select('id, name, weekly_day_target')
    .eq('active', true)
    .order('name');

  if (!clients || clients.length === 0) {
    return { weekStart: weekStartIso, rows: [] };
  }

  const ids = clients.map((c) => c.id);

  const [{ data: weekWorkouts }, { data: lastActivity }, suggestionsByClient] = await Promise.all([
    supa
      .from('workouts')
      .select('client_id, completed_at')
      .in('client_id', ids)
      .eq('week_start', weekStartIso)
      .not('completed_at', 'is', null),
    // Bounded to 90 days: the "last active" caption is hidden when null,
    // so clients dormant longer than that just lose the caption.
    supa
      .from('workouts')
      .select('client_id, started_at')
      .in('client_id', ids)
      .gte('started_at', subDays(at, 90).toISOString())
      .order('started_at', { ascending: false }),
    buildSuggestionsByClient(ids, at),
  ]);

  const daysDoneByClient = new Map<string, number>();
  for (const w of weekWorkouts ?? []) {
    daysDoneByClient.set(w.client_id, (daysDoneByClient.get(w.client_id) ?? 0) + 1);
  }

  const lastActivityByClient = new Map<string, string>();
  for (const w of lastActivity ?? []) {
    if (lastActivityByClient.has(w.client_id)) continue;
    lastActivityByClient.set(w.client_id, w.started_at);
  }

  const rows: ClientStatusRow[] = clients.map((c) => {
    const suggestions = suggestionsByClient.get(c.id) ?? [];
    const { hasActionableIssues, issueCount } = classifyClientStatus(
      suggestions.map((s) => s.type),
    );
    return {
      clientId: c.id,
      name: c.name,
      weeklyDayTarget: c.weekly_day_target,
      daysDone: daysDoneByClient.get(c.id) ?? 0,
      hasActionableIssues,
      issueCount,
      lastActivityAt: lastActivityByClient.get(c.id) ?? null,
    };
  });

  return { weekStart: weekStartIso, rows };
}
