import type { ReactNode } from 'react';

export type KbdSize = 'xs' | 'sm' | 'md';

const SIZE_CLASSES: Record<KbdSize, string> = {
    xs: 'text-[8px] min-w-[10px] h-[10px] px-[2px] pt-[1px]',
    sm: 'text-[10px] min-w-[14px] h-[14px] px-[3px] pt-[1px]',
    md: 'text-[11px] min-w-[18px] h-[18px] px-1 pt-[1px]',
};

/**
 * keyboard-key indicator. pixel face, square (per house style), with a
 * 1px border and a 1px bottom shadow that gives it the visual hint of
 * a physical keycap. `size` defaults to `sm`; use `xs` in tight UI
 * (e.g. the left toolbar's category header).
 *
 * Silkscreen has letters, digits and ASCII punctuation but no modifier
 * symbols — a chord label from `formatKeyLabel` ("⇧F") would draw the ⇧ from
 * the fallback face, antialiased, next to a hard-edged F. Every key bound
 * today is a bare letter, so this doesn't bite; bind a chord and it will.
 */
export function Kbd({ children, size = 'sm', className = '' }: { children: ReactNode; size?: KbdSize; className?: string }) {
    return (
        <kbd
            className={`inline-flex items-center justify-center font-pixel leading-none border border-border bg-surface-muted text-fg shadow-[0_1px_0_0_rgba(0,0,0,0.4)] select-none ${SIZE_CLASSES[size]} ${className}`}
        >
            {children}
        </kbd>
    );
}
