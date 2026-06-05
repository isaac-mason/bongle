import { Menu } from '@base-ui/react/menu';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface DropdownMenuProps {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({ children, open, onOpenChange }: DropdownMenuProps) {
    return (
        <Menu.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
            {children}
        </Menu.Root>
    );
}

interface DropdownMenuTriggerProps {
    children: ReactNode;
    /** Render the single child as the trigger instead of a wrapping button. */
    asChild?: boolean;
    className?: string;
}

export function DropdownMenuTrigger({ children, asChild, className }: DropdownMenuTriggerProps) {
    if (asChild && isValidElement(children)) {
        const child = children as ReactElement;
        // host non-button elements (e.g. a positioned <div>) aren't native
        // buttons; component triggers are assumed to render one.
        const nativeButton = typeof child.type === 'string' ? child.type === 'button' : true;
        return <Menu.Trigger nativeButton={nativeButton} render={child} />;
    }
    return <Menu.Trigger className={className}>{children}</Menu.Trigger>;
}

interface DropdownMenuContentProps {
    children: ReactNode;
    className?: string;
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
}

export function DropdownMenuContent({ children, className, align = 'start', sideOffset = 4 }: DropdownMenuContentProps) {
    return (
        <Menu.Portal>
            <Menu.Positioner align={align} sideOffset={sideOffset}>
                <Menu.Popup
                    className={`z-50 min-w-[120px] py-0.5 bg-white border border-neutral-200 rounded shadow-md ${className ?? ''}`}
                >
                    {children}
                </Menu.Popup>
            </Menu.Positioner>
        </Menu.Portal>
    );
}

interface DropdownMenuItemProps {
    children: ReactNode;
    onSelect?: () => void;
    className?: string;
    variant?: 'default' | 'danger';
    disabled?: boolean;
}

export function DropdownMenuItem({ children, onSelect, className, variant = 'default', disabled }: DropdownMenuItemProps) {
    const variantClasses = disabled
        ? 'text-neutral-300 cursor-not-allowed'
        : variant === 'danger'
          ? 'text-red-600 hover:bg-red-50'
          : 'text-neutral-700 hover:bg-neutral-100';
    return (
        <Menu.Item
            onClick={onSelect ? () => onSelect() : undefined}
            disabled={disabled}
            className={`px-2 py-0.5 text-[10px] font-mono outline-none flex items-center gap-1.5 ${disabled ? '' : 'cursor-pointer'} ${variantClasses} ${className ?? ''}`}
        >
            {children}
        </Menu.Item>
    );
}

export function DropdownMenuSeparator() {
    return <Menu.Separator className="my-0.5 border-t border-neutral-200" />;
}
