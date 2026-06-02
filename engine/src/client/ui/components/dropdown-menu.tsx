import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

interface DropdownMenuProps {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({ children, open, onOpenChange }: DropdownMenuProps) {
    return (
        <RadixDropdownMenu.Root open={open} onOpenChange={onOpenChange}>
            {children}
        </RadixDropdownMenu.Root>
    );
}

export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

interface DropdownMenuContentProps {
    children: ReactNode;
    className?: string;
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
}

export function DropdownMenuContent({ children, className, align = 'start', sideOffset = 4 }: DropdownMenuContentProps) {
    return (
        <RadixDropdownMenu.Portal>
            <RadixDropdownMenu.Content
                align={align}
                sideOffset={sideOffset}
                className={`z-50 min-w-[120px] py-0.5 bg-white border border-neutral-200 rounded shadow-md ${className ?? ''}`}
            >
                {children}
            </RadixDropdownMenu.Content>
        </RadixDropdownMenu.Portal>
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
        <RadixDropdownMenu.Item
            onSelect={onSelect}
            disabled={disabled}
            className={`px-2 py-0.5 text-[10px] font-mono outline-none flex items-center gap-1.5 ${disabled ? '' : 'cursor-pointer'} ${variantClasses} ${className ?? ''}`}
        >
            {children}
        </RadixDropdownMenu.Item>
    );
}

export function DropdownMenuSeparator() {
    return <RadixDropdownMenu.Separator className="my-0.5 border-t border-neutral-200" />;
}
