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
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Enter your PIN</h1>
          <p className="text-sm text-neutral-400">5 digits from your coach</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
