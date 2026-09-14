import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface HoverCardProps {
    children: ReactNode;
}

// opens on hover/focus, unlike Popover which is click-driven; stays open while the pointer is over the popup.
export function HoverCard({ children }: HoverCardProps) {
    return <BasePreviewCard.Root>{children}</BasePreviewCard.Root>;
}

interface HoverCardTriggerProps {
    children: ReactNode;
    /** Render the single child as the trigger instead of a wrapping anchor. */
    asChild?: boolean;
    className?: string;
    delay?: number;
    closeDelay?: number;
}

export function HoverCardTrigger({ children, asChild, className, delay = 150, closeDelay = 0 }: HoverCardTriggerProps) {
    if (asChild && isValidElement(children)) {
        return <BasePreviewCard.Trigger delay={delay} closeDelay={closeDelay} render={children as ReactElement} />;
    }
    return (
        <BasePreviewCard.Trigger delay={delay} closeDelay={closeDelay} className={className}>
            {children}
        </BasePreviewCard.Trigger>
    );
}

interface HoverCardContentProps {
    children: ReactNode;
    className?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
}

// renders in a portal so it escapes overflow clipping, and flips to the opposite side on collision.
export function HoverCardContent({ children, className, side = 'top', align = 'center', sideOffset = 6 }: HoverCardContentProps) {
    return (
        <BasePreviewCard.Portal>
            <BasePreviewCard.Positioner side={side} align={align} sideOffset={sideOffset}>
                <BasePreviewCard.Popup className={`z-50 border border-border bg-surface shadow-lg ${className ?? ''}`}>
                    {children}
                </BasePreviewCard.Popup>
            </BasePreviewCard.Positioner>
        </BasePreviewCard.Portal>
    );
}
