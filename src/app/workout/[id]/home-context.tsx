'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Where the workout screen's "back" links point. A client lands on /today;
 * the coach logging a PT client's session lands back on that client's page.
 * Provided by the server page so the shared chrome stays actor-agnostic.
 */
export type WorkoutHome = { href: string; label: string };

const DEFAULT_HOME: WorkoutHome = { href: '/today', label: 'Today' };

const WorkoutHomeContext = createContext<WorkoutHome>(DEFAULT_HOME);

export function WorkoutHomeProvider({
  home,
  children,
}: {
  home: WorkoutHome;
  children: ReactNode;
}) {
  return <WorkoutHomeContext.Provider value={home}>{children}</WorkoutHomeContext.Provider>;
}

export function useWorkoutHome(): WorkoutHome {
  return useContext(WorkoutHomeContext);
}
