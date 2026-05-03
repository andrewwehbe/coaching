import { LogoutButton } from '@/components/logout-button';

export default function Deactivated() {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-sm space-y-6 text-center">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-warn/10 ring-1 ring-warn/30 flex items-center justify-center">
          <span className="text-warn text-2xl">⏸</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Access paused</h1>
        <p className="text-muted text-sm">
          Your account has been paused. Talk to your coach to reactivate it.
        </p>
        <LogoutButton />
      </div>
    </main>
  );
}
