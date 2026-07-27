import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface HoverCardProps {
    children: ReactNode;
}

/**
 * Hover card root. Opens on pointer hover / focus (unlike Popover, which is
 * click-driven) and stays open while the pointer is over the popup, so the
 * content may be interactive. Wrap a `HoverCardTrigger` and `HoverCardContent`.
 */
export function HoverCard({ children }: HoverCardProps) {
    return <BasePreviewCard.Root>{children}</BasePreviewCard.Root>;
}

interface HoverCardTriggerProps {
    children: ReactNode;
    /** Render the single child as the trigger instead of a wrapping anchor. */
    asChild?: boolean;
    className?: string;
    /** ms the pointer must dwell before opening. Default: 150. */
    delay?: number;
    /** ms after leaving before closing. Default: 0. */
    closeDelay?: number;
}

/**
 * Hover card trigger. With `asChild`, the single child element becomes the
 * hover anchor (Base UI's `render` prop); otherwise it renders a default anchor.
 */
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
    /** Side of the trigger to place on. Default: 'top'. */
    side?: 'top' | 'bottom' | 'left' | 'right';
    /** Alignment relative to trigger. Default: 'center'. */
    align?: 'start' | 'center' | 'end';
    /** Side offset in px. Default: 6. */
    sideOffset?: number;
}

/**
 * Hover card content panel. Renders in a portal so it escapes overflow clipping,
 * and flips to the opposite side on collision.
 */
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
