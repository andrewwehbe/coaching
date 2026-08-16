'use client';

import { Button } from '@/components/ui';

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="max-w-sm w-full space-y-6">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-warn/10 ring-1 ring-warn/40 flex items-center justify-center">
          <svg className="h-7 w-7 text-warn" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364m0-12.728l12.728 12.728" />
          </svg>
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">No connection</h1>
          <p className="text-sm text-muted">
            You&apos;re offline. Sets you log will sync the moment you&apos;re back online.
          </p>
        </div>
        <Button variant="cta" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </main>
  );
}
