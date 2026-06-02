import { type ComponentProps, forwardRef } from 'react';

/* ── Text input ─────────────────────────────────────────────────── */

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(({ className, ...props }, ref) => (
    <input
        ref={ref}
        className={`w-full bg-neutral-50 border border-neutral-200 rounded px-1.5 py-0.5 text-[10px] font-mono text-neutral-700 outline-none focus:border-neutral-400 ${className ?? ''}`}
        {...props}
    />
));

Input.displayName = 'Input';

/* ── Select ─────────────────────────────────────────────────────── */

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(({ className, ...props }, ref) => (
    <select
        ref={ref}
        className={`w-full bg-neutral-50 border border-neutral-200 rounded px-1 py-0.5 text-[10px] font-mono text-neutral-700 outline-none focus:border-neutral-400 ${className ?? ''}`}
        {...props}
    />
));

Select.displayName = 'Select';
