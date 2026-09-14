import type { ReactNode } from 'react';

export function SectionHeader({ children }: { children: ReactNode }) {
    return <div className="text-[10px] font-mono font-semibold text-text-secondary uppercase tracking-wide mb-1">{children}</div>;
}

export function PanelHeader({ children }: { children: ReactNode }) {
    return (
        <div className="px-2 py-1.5 text-[11px] font-mono font-semibold text-text-secondary uppercase tracking-wide border-b border-border-primary">
            {children}
        </div>
    );
}
