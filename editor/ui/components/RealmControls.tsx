// editor/ui/components/RealmControls.tsx — the shared action bar + button for the
// realm log windows (build / server / client). One consistent look for every
// realm's kill/restart/clear controls, matching the editor's square, black-border,
// no-radius style. Each panel composes its own <ActionButton>s inside an <ActionBar>.

import type { ReactNode } from 'react';
import { Eraser } from '../../../icons';
import { type LogStream, useLogs } from '../../stores/logs';

/** the top strip a realm panel hangs its actions off — bordered, flush to the top. */
export function ActionBar({ children }: { children: ReactNode }) {
    return <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">{children}</div>;
}

export function ActionButton({
    icon,
    label,
    onClick,
    disabled,
    busy,
    title,
}: {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
    title?: string;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            title={title}
            className="flex items-center gap-1 border border-border bg-surface px-2 py-1 text-fg text-xs hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
            {icon}
            {busy ? `${label}…` : label}
        </button>
    );
}

/** clear one log stream — every realm panel carries it, so it lives here. */
export function ClearLogsButton({ stream }: { stream: LogStream }) {
    const clear = useLogs((s) => s.clear);
    return <ActionButton icon={<Eraser size={13} />} label="clear" title="Clear this log" onClick={() => clear(stream)} />;
}
