import { Popover as BasePopover } from '@base-ui/react/popover';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface PopoverProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}

export function Popover({ open, onOpenChange, children }: PopoverProps) {
    return (
        <BasePopover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
            {children}
        </BasePopover.Root>
    );
}

interface PopoverTriggerProps {
    children: ReactNode;
    /** Render the single child as the trigger instead of a wrapping button. */
    asChild?: boolean;
    className?: string;
}

export function PopoverTrigger({ children, asChild, className }: PopoverTriggerProps) {
    if (asChild && isValidElement(children)) {
        const child = children as ReactElement;
        // host non-button elements (e.g. a positioned div) aren't native buttons; component triggers are assumed to render one.
        const nativeButton = typeof child.type === 'string' ? child.type === 'button' : true;
        return <BasePopover.Trigger nativeButton={nativeButton} render={child} />;
    }
    return <BasePopover.Trigger className={className}>{children}</BasePopover.Trigger>;
}

interface PopoverContentProps {
    children: ReactNode;
    className?: string;
    /** Alignment relative to trigger. Default: 'start'. */
    align?: 'start' | 'center' | 'end';
    /** Side offset in px. Default: 4. */
    sideOffset?: number;
}

// renders in a portal so it escapes overflow clipping.
export function PopoverContent({ children, className, align = 'start', sideOffset = 4 }: PopoverContentProps) {
    return (
        <BasePopover.Portal>
            <BasePopover.Positioner align={align} sideOffset={sideOffset}>
                <BasePopover.Popup className={`z-50 bg-surface border border-border shadow-lg ${className ?? ''}`}>
                    {children}
                </BasePopover.Popup>
            </BasePopover.Positioner>
        </BasePopover.Portal>
    );
}
