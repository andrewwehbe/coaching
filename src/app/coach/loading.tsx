import { Skeleton, SkeletonText } from '@/components/skeleton';

/**
 * Nearest loading boundary for every /coach/* route without its own.
 * Streams instantly on navigation so the nav stays responsive while the
 * server waterfall runs.
 */
export default function CoachLoading() {
  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <SkeletonText className="h-3 w-24 mb-3" />
      <SkeletonText className="h-8 w-48 mb-8" />
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </main>
  );
}
