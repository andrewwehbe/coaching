import { SkeletonText } from '@/components/skeleton';

export default function TodayLoading() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
      <SkeletonText className="h-3 w-28" />
      <SkeletonText className="h-9 w-44" />
      <SkeletonText className="h-3 w-36" />
    </main>
  );
}
