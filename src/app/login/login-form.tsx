'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';

const LEN = 5;

export function LoginForm() {
  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const router = useRouter();

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  function set(i: number, v: string) {
    const cleaned = v.replace(/\D/g, '').slice(0, 1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = cleaned;
      return next;
    });
    if (cleaned && i < LEN - 1) inputs.current[i + 1]?.focus();
  }

  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      inputs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < LEN - 1) {
      inputs.current[i + 1]?.focus();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LEN);
    if (text.length >= 1) {
      e.preventDefault();
      const next = Array(LEN).fill('');
      for (let i = 0; i < text.length; i++) next[i] = text[i];
      setDigits(next);
      const focusAt = Math.min(text.length, LEN - 1);
      inputs.current[focusAt]?.focus();
    }
  }

  async function submit(pin: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Login failed');
        setDigits(Array(LEN).fill(''));
        inputs.current[0]?.focus();
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    const pin = digits.join('');
    if (pin.length === LEN && !submitting) {
      void submit(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits.join('')]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const pin = digits.join('');
        if (pin.length === LEN) void submit(pin);
      }}
      className="space-y-6"
    >
      <div className="flex justify-center gap-2" onPaste={onPaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              inputs.current[i] = el;
            }}
            type="tel"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={1}
            disabled={submitting}
            value={d}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            className="h-16 w-12 text-center text-3xl font-semibold rounded-xl bg-neutral-900 border border-neutral-800 focus:outline-none focus:border-neutral-500 disabled:opacity-50 caret-transparent"
          />
        ))}
      </div>
      {error && (
        <p className="text-center text-sm text-red-400">{error}</p>
      )}
    </form>
  );
}
