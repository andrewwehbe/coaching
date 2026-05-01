'use client';

export function OfflineBanner({ online, pending }: { online: boolean; pending: number }) {
  if (online && pending === 0) return null;

  if (!online) {
    return (
      <div className="mb-4 rounded-2xl border border-warn/35 bg-warn/10 px-4 py-2.5 text-sm text-warn flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-warn animate-soft-pulse" />
        <span>
          <strong className="font-semibold">Offline.</strong> Sets save locally and sync when you&apos;re back.
          {pending > 0 && <> ({pending} pending)</>}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-accent/30 bg-accent/8 px-4 py-2.5 text-sm text-accent flex items-center gap-2">
      <span className="h-2 w-2 rounded-full bg-accent animate-soft-pulse" />
      <span>Syncing {pending} pending {pending === 1 ? 'set' : 'sets'}…</span>
    </div>
  );
}
