/**
 * Loading-state placeholder blocks used by route-level loading.tsx files.
 * Pure presentational; keep in sync with the surface/border tokens in
 * globals.css so skeletons read as the same material as real cards.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-[var(--r-control)] bg-surface/60 border border-border/40 ${className}`}
    />
  );
}

export function SkeletonText({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface ${className}`} />;
}
