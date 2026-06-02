import type { ReactNode } from 'react';

/**
 * Uppercase tracking-wide section header used in both panels.
 */
export function SectionHeader({ children }: { children: ReactNode }) {
    return <div className="text-[10px] font-mono font-semibold text-text-secondary uppercase tracking-wide mb-1">{children}</div>;
}

/**
 * Panel title bar with bottom border.
 */
export function PanelHeader({ children }: { children: ReactNode }) {
    return (
        <div className="px-2 py-1.5 text-[11px] font-mono font-semibold text-text-secondary uppercase tracking-wide border-b border-border-primary">
            {children}
        </div>
    );
}
