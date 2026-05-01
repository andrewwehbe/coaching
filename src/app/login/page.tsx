import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const user = await readSession();
  if (user) {
    if (user.type === 'coach') redirect('/coach');
    if (!user.active) redirect('/deactivated');
    redirect('/today');
  }
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-10">
        <div className="text-center space-y-3">
          <div className="mx-auto h-12 w-12 rounded-2xl bg-primary/15 ring-1 ring-primary/40 flex items-center justify-center shadow-[0_0_40px_-10px_rgba(34,197,94,0.6)]">
            <span className="text-primary-hi text-2xl font-bold tracking-tight">C</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Enter your PIN</h1>
          <p className="text-sm text-muted">5 digits from your coach</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
