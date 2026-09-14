import { type ComponentProps, forwardRef } from 'react';

/** the box: `icon*` are fixed squares (a glyph, no label), the rest size to content. */
export type ButtonSize = 'xs' | 'sm' | 'icon-sm' | 'icon';
/** idle, selected (accent fill: a held tool, an open panel), or a solid action fill. */
export type ButtonTone = 'default' | 'active' | 'success' | 'danger';

const SIZES: Record<ButtonSize, string> = {
    xs: 'h-5 px-1.5 gap-1 text-[10px]',
    sm: 'h-6 px-2 gap-1 text-[11px]',
    'icon-sm': 'w-5 h-5',
    icon: 'w-8 h-8',
};

const BASE = 'inline-flex items-center justify-center font-mono leading-none border transition-colors';

const TONES: Record<ButtonTone, string> = {
    default: 'bg-surface text-fg border-border hover:bg-surface-muted hover:border-fg-muted',
    active: 'bg-accent text-on-accent border-accent',
    success: 'bg-success-solid text-white border-success-solid hover:opacity-85',
    danger: 'bg-danger-solid text-white border-danger-solid hover:opacity-85',
};

/** the class string on its own, for call sites that compose their own element (a split tab, an anchor). */
export function buttonClass(size: ButtonSize = 'sm', tone: ButtonTone = 'default', disabled = false): string {
    // disabled dims the tone rather than replacing it, so a solid action button stays recognisable.
    return `${BASE} ${SIZES[size]} ${TONES[tone]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`;
}

export type ButtonProps = ComponentProps<'button'> & { size?: ButtonSize; tone?: ButtonTone };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ size = 'sm', tone = 'default', disabled, className, ...props }, ref) => (
        <button
            ref={ref}
            type="button"
            disabled={disabled}
            className={`${buttonClass(size, tone, disabled)} ${className ?? ''}`}
            {...props}
        />
    ),
);
Button.displayName = 'Button';
