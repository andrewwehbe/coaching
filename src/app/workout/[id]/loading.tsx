import { Skeleton, SkeletonText } from '@/components/skeleton';

/**
 * Workout-logger skeleton — mirrors the session layout (header row,
 * progress bar, exercise title, set list, entry form) so the transition
 * into the real screen doesn't jump.
 */
export default function WorkoutLoading() {
  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <div className="flex items-center justify-between mb-4">
        <SkeletonText className="h-4 w-16" />
        <SkeletonText className="h-4 w-10" />
      </div>
      <SkeletonText className="h-1 w-full mb-8" />
      <SkeletonText className="h-3 w-20 mb-2" />
      <SkeletonText className="h-9 w-52 mb-2" />
      <SkeletonText className="h-4 w-36 mb-8" />
      <div className="space-y-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-28" />
      </div>
      <div className="mt-auto pt-8">
        <Skeleton className="h-14 rounded-2xl" />
      </div>
    </main>
  );
}
