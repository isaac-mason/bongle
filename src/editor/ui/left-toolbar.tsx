import { useRef, useState } from 'react';
import { Debug, ShoppingBag } from '../../../icons';
import { Button } from '../../client/ui/components';
import { useClient } from '../../client/ui/stores/client-store';
import { useEditRoom } from '../edit-room-store';
import { formatKeyLabel, LIBRARY_KEYS } from '../editor-controls';
import { TOOL_CATEGORIES, type ToolCategory, type ToolDef } from '../tool-categories';
import { Kbd } from './kbd';

// outset far enough off the corner to clear the icon glyph; the tool list below carries
// horizontal padding for this, since overflow-y forces overflow-x: auto and would clip the tag.
function SlotBadge({ digit }: { digit: number }) {
    return (
        <span className="pointer-events-none absolute right-[-3px] bottom-[-3px] inline-flex h-[12px] min-w-[12px] select-none items-center justify-center bg-fg px-[2px] font-pixel text-[8px] text-desktop leading-none">
            {digit}
        </span>
    );
}

function ToolButton({
    def,
    active,
    categoryKeyLabel,
    slotDigit,
    showSlot,
    onSelect,
}: {
    def: ToolDef;
    active: boolean;
    categoryKeyLabel: string;
    slotDigit: number;
    showSlot: boolean;
    onSelect: () => void;
}) {
    // fixed-positioned (below) so the popover escapes the toolbar's scroll clip.
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const Icon = def.icon;

    const showPopover = () => {
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setPos({ left: r.right + 8, top: r.top + r.height / 2 });
    };

    return (
        <div className="relative">
            <Button
                ref={btnRef}
                size="icon"
                tone={active ? 'active' : 'default'}
                onClick={onSelect}
                onMouseEnter={showPopover}
                onMouseLeave={() => setPos(null)}
                title={showSlot ? `${def.label}  (${categoryKeyLabel}·${slotDigit})` : `${def.label}  (${categoryKeyLabel})`}
                className="relative"
            >
                <Icon size={24} />
                {showSlot && <SlotBadge digit={slotDigit} />}
            </Button>

            {pos && (
                <div
                    className="fixed -translate-y-1/2 z-50 pointer-events-none select-none"
                    style={{ left: pos.left, top: pos.top }}
                >
                    <div className="bg-surface-muted text-fg border border-border px-2 py-1.5 shadow-lg whitespace-nowrap">
                        <div className="flex items-center gap-2">
                            <div className="text-[11px] font-mono font-semibold">{def.label}</div>
                            <div className="flex items-center gap-0.5">
                                <Kbd size="sm">{categoryKeyLabel}</Kbd>
                                {showSlot && (
                                    <>
                                        <span className="text-[10px] text-fg-muted">+</span>
                                        <Kbd size="sm">{slotDigit}</Kbd>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="text-[10px] font-mono text-fg-muted mt-0.5">{def.hint}</div>
                    </div>
                </div>
            )}
        </div>
    );
}

function InventoryButton() {
    const libraryOpen = useEditRoom((s) => s.libraryOpen);
    const toggleLibrary = useEditRoom((s) => s.toggleLibrary);
    const keyLabel = formatKeyLabel(LIBRARY_KEYS.toggleLibrary);

    return (
        <div className="flex flex-col items-center gap-1 pb-1">
            <Kbd size="xs">{keyLabel}</Kbd>
            <Button
                size="icon"
                tone={libraryOpen ? 'active' : 'default'}
                onClick={toggleLibrary}
                title={`inventory  (${keyLabel})`}
            >
                <ShoppingBag size={24} />
            </Button>
            <div className="w-6 h-px bg-border mt-1" />
        </div>
    );
}

// mirrors the backtick key that opens the same perf/logs panel.
function DebugButton() {
    const debugOpen = useClient((s) => s.debugOpen);
    const toggleDebug = useClient((s) => s.toggleDebugOpen);

    return (
        <div className="mt-auto flex flex-col items-center gap-1 pt-1">
            <div className="w-6 h-px bg-border mb-1" />
            <Kbd size="xs">{'`'}</Kbd>
            <Button size="icon" tone={debugOpen ? 'active' : 'default'} onClick={toggleDebug} title="debug panel  (`)">
                <Debug size={24} />
            </Button>
        </div>
    );
}

export function LeftToolbar() {
    const activeTool = useEditRoom((s) => s.activeTool);
    const setActiveTool = useEditRoom((s) => s.setActiveTool);

    return (
        <div className="w-12 flex-shrink-0 flex flex-col items-center pt-2 pb-2 bg-surface border-r border-border">
            <InventoryButton />

            <div className="flex flex-col items-stretch gap-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {TOOL_CATEGORIES.map((category: ToolCategory, ci) => {
                    const CategoryIcon = category.icon;
                    return (
                        <div key={category.id} className="flex flex-col items-center gap-1">
                            {ci > 0 && <div className="w-6 h-px bg-border my-1" />}
                            <div
                                className="flex flex-row items-center gap-1 select-none mb-1"
                                title={`category: ${category.label} (${formatKeyLabel(category.key)})`}
                            >
                                <CategoryIcon size={12} className="text-fg" />
                                <Kbd size="xs">{formatKeyLabel(category.key)}</Kbd>
                            </div>
                            {category.tools.map((def, ti) => (
                                <ToolButton
                                    key={def.id}
                                    def={def}
                                    active={activeTool === def.id}
                                    categoryKeyLabel={formatKeyLabel(category.key)}
                                    slotDigit={ti + 1}
                                    showSlot={category.tools.length > 1}
                                    onSelect={() => setActiveTool(def.id)}
                                />
                            ))}
                        </div>
                    );
                })}
            </div>

            <DebugButton />
        </div>
    );
}
