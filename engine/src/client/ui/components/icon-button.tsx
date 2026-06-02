import type { ComponentProps } from 'react';

type IconButtonProps = ComponentProps<'button'> & {
    /** Visual variant. 'danger' shows red on hover. */
    variant?: 'default' | 'danger';
};

/**
 * Small icon-sized button for inline actions (remove, close, etc).
 */
export function IconButton({ variant = 'default', className, ...props }: IconButtonProps) {
    const variantClass = variant === 'danger' ? 'text-neutral-400 hover:text-red-500' : 'text-neutral-400 hover:text-neutral-600';

    return (
        <button
            type="button"
            className={`shrink-0 text-[10px] px-1 cursor-pointer ${variantClass} ${className ?? ''}`}
            {...props}
        />
    );
}
