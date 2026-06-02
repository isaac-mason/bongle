import * as RadixCollapsible from '@radix-ui/react-collapsible';
import type { ReactNode } from 'react';

interface CollapsibleProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}

/**
 * Collapsible section with a trigger and content.
 */
export function Collapsible({ open, onOpenChange, children }: CollapsibleProps) {
    return (
        <RadixCollapsible.Root open={open} onOpenChange={onOpenChange}>
            {children}
        </RadixCollapsible.Root>
    );
}

export const CollapsibleTrigger = RadixCollapsible.Trigger;
export const CollapsibleContent = RadixCollapsible.Content;
