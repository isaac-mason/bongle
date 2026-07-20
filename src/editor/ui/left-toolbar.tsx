import { Grid3x3 } from 'bongle/icons';
import { useState } from 'react';
import { useEditRoom } from '../edit-room-store';
import { formatKeyLabel, LIBRARY_KEYS } from '../editor-controls';
import { TOOL_CATEGORIES, type ToolCategory, type ToolDef } from '../tool-categories';
import { Kbd } from './kbd';

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
    const [hovered, setHovered] = useState(false);
    const Icon = def.icon;

    return (
        <div className="relative">
            <button
                type="button"
                onClick={onSelect}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                title={showSlot ? `${def.label}  (${categoryKeyLabel}·${slotDigit})` : `${def.label}  (${categoryKeyLabel})`}
                className={`relative w-8 h-8 flex items-center justify-center rounded-sm cursor-pointer transition-colors border ${
                    active
                        ? 'bg-accent text-on-accent border-accent'
                        : 'text-fg border-border hover:bg-surface-muted hover:text-fg'
                }`}
            >
                <Icon size={15} />
                {showSlot && (
                    <span
                        className={`absolute bottom-0.5 right-0.5 text-[8px] font-mono leading-none select-none pointer-events-none ${
                            active ? 'text-on-accent' : 'text-fg-muted'
                        }`}
                    >
                        {slotDigit}
                    </span>
                )}
            </button>

            {/* hover popover */}
            {hovered && (
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 pointer-events-none select-none">
                    <div className="bg-surface-muted text-fg border border-border rounded-md px-2 py-1.5 shadow-lg whitespace-nowrap">
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
        <div className="mt-auto flex flex-col items-center gap-1 pt-1">
            <div className="w-6 h-px bg-border mb-1" />
            {/* control indicator: the key that toggles the inventory */}
            <Kbd size="xs">{keyLabel}</Kbd>
            <button
                type="button"
                onClick={toggleLibrary}
                title={`inventory  (${keyLabel})`}
                className={`w-8 h-8 flex items-center justify-center rounded-sm cursor-pointer transition-colors border ${
                    libraryOpen
                        ? 'bg-accent text-on-accent border-accent'
                        : 'text-fg border-border hover:bg-surface-muted hover:text-fg'
                }`}
            >
                <Grid3x3 size={15} />
            </button>
        </div>
    );
}

export function LeftToolbar() {
    const activeTool = useEditRoom((s) => s.activeTool);
    const setActiveTool = useEditRoom((s) => s.setActiveTool);

    return (
        <div className="w-12 flex-shrink-0 flex flex-col items-center pt-2 pb-2 bg-surface border-r border-border">
            {/* tools, grouped by category. each group has a small header like
                "scene v", the category name plus its hotkey. per-tool slot
                digits appear in the bottom-right corner of each icon. */}
            <div className="flex flex-col items-stretch gap-1">
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

            {/* inventory (library) toggle, pinned to the bottom with an E key hint */}
            <InventoryButton />
        </div>
    );
}
