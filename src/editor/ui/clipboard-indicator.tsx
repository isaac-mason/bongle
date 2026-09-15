import * as Icons from '../../../icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../client/ui/components';
import type { Blueprint } from '../blueprint';
import { useEditRoom } from '../edit-room-store';

/** "3×2×4 · 12b" for voxels, "2n" for nodes, joined when a copy holds both. falls back to the
 *  blueprint's own label (a scene id, for a saved-scene copy) if neither applies. */
function summarize(bp: Blueprint): string {
    const parts: string[] = [];
    if (bp.hasVoxels) parts.push(`${bp.size[0]}×${bp.size[1]}×${bp.size[2]} · ${bp.blockCount}b`);
    if (bp.hasNodes) parts.push(`${bp.nodes.length}n`);
    return parts.length > 0 ? parts.join(' + ') : bp.label;
}

/** unpositioned: the caller places it (currently to the right of the hotbar). shows what a
 *  Ctrl+V would paste right now, and a dropdown of recent copies/cuts to reach back into — picking
 *  one re-arms it as the active clipboard and starts placing it, same as a fresh paste. */
export function ClipboardIndicator() {
    const active = useEditRoom((s) => s.activeBlueprint);
    const history = useEditRoom((s) => s.clipboardHistory);
    const pasteFromHistory = useEditRoom((s) => s.pasteFromHistory);
    const copyHistoryToClipboard = useEditRoom((s) => s.copyHistoryToClipboard);

    if (!active && history.length === 0) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={active ? `clipboard: ${summarize(active)}` : 'clipboard history'}
                    className="flex items-center gap-1.5 px-2 bg-surface/90 border border-border shadow-md backdrop-blur-sm text-fg-muted hover:text-fg pointer-events-auto text-[10px] font-mono"
                >
                    <Icons.ClipboardCopy size={12} />
                    {active && <span className="whitespace-nowrap">{summarize(active)}</span>}
                </button>
            </DropdownMenuTrigger>
            {history.length > 0 && (
                <DropdownMenuContent align="end" sideOffset={4}>
                    {history.map((bp) => (
                        // the copy button sits OUTSIDE the menu item rather than nested in it, so a
                        // click on it can't also fire the item's own place-it action.
                        <div key={bp.id} className="flex items-stretch">
                            <DropdownMenuItem className="flex-1" onSelect={() => pasteFromHistory(bp.id)}>
                                <span className={bp.id === active?.id ? 'text-fg' : undefined}>{summarize(bp)}</span>
                            </DropdownMenuItem>
                            <button
                                type="button"
                                title="copy to system clipboard"
                                onClick={() => copyHistoryToClipboard(bp.id)}
                                className="px-2 text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer"
                            >
                                <Icons.ClipboardCopy size={12} />
                            </button>
                        </div>
                    ))}
                </DropdownMenuContent>
            )}
        </DropdownMenu>
    );
}
