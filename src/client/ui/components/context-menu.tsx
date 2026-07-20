import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface ContextMenuProps {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function ContextMenu({ children, open, onOpenChange }: ContextMenuProps) {
    return (
        <BaseContextMenu.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
            {children}
        </BaseContextMenu.Root>
    );
}

interface ContextMenuTriggerProps {
    children: ReactNode;
    /** Render the single child as the trigger area instead of a wrapping div. */
    asChild?: boolean;
    className?: string;
}

export function ContextMenuTrigger({ children, asChild, className }: ContextMenuTriggerProps) {
    if (asChild && isValidElement(children)) {
        return <BaseContextMenu.Trigger render={children as ReactElement} />;
    }
    return <BaseContextMenu.Trigger className={className}>{children}</BaseContextMenu.Trigger>;
}

interface ContextMenuContentProps {
    children: ReactNode;
    className?: string;
}

export function ContextMenuContent({ children, className }: ContextMenuContentProps) {
    return (
        <BaseContextMenu.Portal>
            <BaseContextMenu.Positioner>
                <BaseContextMenu.Popup
                    className={`z-50 min-w-[120px] py-0.5 bg-surface border border-border rounded shadow-md ${className ?? ''}`}
                >
                    {children}
                </BaseContextMenu.Popup>
            </BaseContextMenu.Positioner>
        </BaseContextMenu.Portal>
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
        ? 'text-fg-muted opacity-50 cursor-not-allowed'
        : variant === 'danger'
          ? 'text-danger hover:bg-danger/15'
          : 'text-fg hover:bg-surface-muted';
    return (
        <BaseContextMenu.Item
            onClick={onSelect ? () => onSelect() : undefined}
            disabled={disabled}
            className={`px-2 py-0.5 text-[10px] font-mono outline-none flex items-center gap-1.5 ${disabled ? '' : 'cursor-pointer'} ${variantClasses} ${className ?? ''}`}
        >
            {children}
        </BaseContextMenu.Item>
    );
}

export function ContextMenuSeparator() {
    return <BaseContextMenu.Separator className="my-0.5 border-t border-border" />;
}
