import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';

interface PopoverProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}

/**
 * Controlled popover root. Wrap a `PopoverTrigger` and `PopoverContent`.
 */
export function Popover({ open, onOpenChange, children }: PopoverProps) {
    return (
        <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
            {children}
        </RadixPopover.Root>
    );
}

export const PopoverTrigger = RadixPopover.Trigger;

interface PopoverContentProps {
    children: ReactNode;
    className?: string;
    /** Alignment relative to trigger. Default: 'start'. */
    align?: 'start' | 'center' | 'end';
    /** Side offset in px. Default: 4. */
    sideOffset?: number;
}

/**
 * Popover content panel. Renders in a portal so it escapes overflow clipping.
 */
export function PopoverContent({ children, className, align = 'start', sideOffset = 4 }: PopoverContentProps) {
    return (
        <RadixPopover.Portal>
            <RadixPopover.Content
                align={align}
                sideOffset={sideOffset}
                className={`z-50 bg-white border border-neutral-200 rounded shadow-lg ${className ?? ''}`}
            >
                {children}
            </RadixPopover.Content>
        </RadixPopover.Portal>
    );
}
