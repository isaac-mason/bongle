import * as RadixContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

interface ContextMenuProps {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function ContextMenu({ children, open, onOpenChange }: ContextMenuProps) {
    return (
        <RadixContextMenu.Root open={open} onOpenChange={onOpenChange}>
            {children}
        </RadixContextMenu.Root>
    );
}

export const ContextMenuTrigger = RadixContextMenu.Trigger;

interface ContextMenuContentProps {
    children: ReactNode;
    className?: string;
}

export function ContextMenuContent({ children, className }: ContextMenuContentProps) {
    return (
        <RadixContextMenu.Portal>
            <RadixContextMenu.Content
                className={`z-50 min-w-[120px] py-0.5 bg-white border border-neutral-200 rounded shadow-md ${className ?? ''}`}
            >
                {children}
            </RadixContextMenu.Content>
        </RadixContextMenu.Portal>
    );
}

interface ContextMenuItemProps {
    children: ReactNode;
    onSelect?: () => void;
    className?: string;
    variant?: 'default' | 'danger';
    disabled?: boolean;
}

export function ContextMenuItem({ children, onSelect, className, variant = 'default', disabled }: ContextMenuItemProps) {
    const variantClasses = disabled
        ? 'text-neutral-300 cursor-not-allowed'
        : variant === 'danger'
          ? 'text-red-600 hover:bg-red-50'
          : 'text-neutral-700 hover:bg-neutral-100';
    return (
        <RadixContextMenu.Item
            onSelect={onSelect}
            disabled={disabled}
            className={`px-2 py-0.5 text-[10px] font-mono outline-none flex items-center gap-1.5 ${disabled ? '' : 'cursor-pointer'} ${variantClasses} ${className ?? ''}`}
        >
            {children}
        </RadixContextMenu.Item>
    );
}

export function ContextMenuSeparator() {
    return <RadixContextMenu.Separator className="my-0.5 border-t border-neutral-200" />;
}
