import { Skeleton, SkeletonText } from '@/components/skeleton';

/**
 * Client-detail skeleton — this is the coach's heaviest route (effort
 * window + recommender + program + check-ins), so paint its shape
 * immediately instead of a frozen screen.
 */
export default function ClientDetailLoading() {
  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <SkeletonText className="h-3 w-32 mb-3" />
      <SkeletonText className="h-8 w-56 mb-3" />
      <div className="flex gap-2 mb-8">
        <SkeletonText className="h-6 w-20" />
        <SkeletonText className="h-6 w-24" />
        <SkeletonText className="h-6 w-16" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-56" />
      </div>
    </main>
  );
}
