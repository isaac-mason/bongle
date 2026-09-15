import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../../client/ui/components';
import * as Selection from '../../core/scene/selection';
import { activeEditRoomStore, useEditRoom } from '../edit-room-store';
import { buildViewportMenuEntries } from './viewport-menu-entries';

/** the click-triggered dropdown (cursor visible, not pointer-locked); see `radial-menu.tsx` for
 *  the hold-RMB pointer-locked counterpart. both render `buildViewportMenuEntries`'s output, so
 *  the two can never show different actions for the same selection. */
export function ViewportContextMenu() {
    const store = activeEditRoomStore();
    const menu = useEditRoom((s) => s.viewportContextMenu);
    // re-render on the inputs buildViewportMenuEntries reads, even though it isn't itself a hook.
    useEditRoom((s) => s.selection.nodes.size);
    useEditRoom((s) => Selection.countVoxels(s.selection));
    useEditRoom((s) => s.activeSlotIndex);
    const close = useEditRoom((s) => s.closeViewportContextMenu);

    const open = !!menu && !menu.radial;
    const entries = open ? buildViewportMenuEntries(store) : [];

    const handleOpenChange = (next: boolean) => {
        if (!next) close();
    };

    return (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
                <div
                    aria-hidden
                    style={{
                        position: 'absolute',
                        left: menu?.x ?? 0,
                        top: menu?.y ?? 0,
                        width: 1,
                        height: 1,
                        pointerEvents: 'none',
                    }}
                />
            </DropdownMenuTrigger>
            {open && entries.length > 0 && (
                <DropdownMenuContent align="start" sideOffset={0}>
                    {entries.map((entry) =>
                        entry.kind === 'separator' ? (
                            <DropdownMenuSeparator key={entry.id} />
                        ) : (
                            <DropdownMenuItem key={entry.id} onSelect={entry.onSelect} variant={entry.variant}>
                                <entry.Icon size={12} /> {entry.label}
                            </DropdownMenuItem>
                        ),
                    )}
                </DropdownMenuContent>
            )}
        </DropdownMenu>
    );
}
