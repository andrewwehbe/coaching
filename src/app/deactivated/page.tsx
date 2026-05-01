import { LogoutButton } from '@/components/logout-button';

export default function Deactivated() {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-semibold">Access paused</h1>
        <p className="text-neutral-400">
          Your account has been paused. Talk to your coach to reactivate it.
        </p>
        <LogoutButton />
      </div>
    </main>
  );
}
