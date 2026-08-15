import { Skeleton, SkeletonText } from '@/components/skeleton';

export default function TrendsLoading() {
  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <SkeletonText className="h-3 w-20 mb-3" />
      <SkeletonText className="h-8 w-36 mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-40" />
        <Skeleton className="h-32" />
      </div>
    </main>
  );
}
