'use client';

import { useId, type ComponentProps } from 'react';

/**
 * Labeled input with the label actually wired (htmlFor) — the workout
 * logger's Weight/Reps/RIR inputs previously had visual-sibling labels
 * that screen readers never announced. Styles match the existing input
 * dialect; the 16px floor in globals.css prevents iOS focus-zoom.
 */
export const inputClasses =
  'w-full h-12 px-3 rounded-[var(--r-control)] bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-lg tabular-nums transition-shadow placeholder:text-faint';

export function Field({
  label,
  hint,
  className = '',
  inputClassName = '',
  ...input
}: ComponentProps<'input'> & {
  label: string;
  hint?: string;
  inputClassName?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs text-faint mb-1">
        {label}
      </label>
      <input id={id} className={`${inputClasses} ${inputClassName}`.trim()} {...input} />
      {hint && <p className="mt-1 text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

export function TextareaField({
  label,
  className = '',
  inputClassName = '',
  ...textarea
}: ComponentProps<'textarea'> & {
  label?: string;
  inputClassName?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="block text-xs text-faint mb-1">
          {label}
        </label>
      )}
      <textarea
        id={id}
        className={`w-full px-3 py-2 rounded-[var(--r-control)] bg-surface border border-border focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-base transition-shadow placeholder:text-faint ${inputClassName}`.trim()}
        {...textarea}
      />
    </div>
  );
}
