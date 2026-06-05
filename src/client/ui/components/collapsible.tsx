import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
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
        <BaseCollapsible.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
            {children}
        </BaseCollapsible.Root>
    );
}

export const CollapsibleTrigger = BaseCollapsible.Trigger;
export const CollapsibleContent = BaseCollapsible.Panel;
