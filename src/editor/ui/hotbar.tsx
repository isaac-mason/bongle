/**
 * hotbar, fixed bottom-center bar with HOTBAR_SIZE slots.
 *
 * each slot is a click target. when no item is carried, click activates the
 * slot. when carrying an inventory item (minecraft-style), click drops it
 * into the slot and clears the carry. right-click clears a slot.
 */

import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { HOTBAR_SIZE, type HotbarSlot, inventoryItemDisplay } from '../inventory';
import { InventoryItemIcon } from './inventory-icon';

const SLOT_SIZE = 40;
const ICON_SIZE = 28;

export function Hotbar() {
    const hotbar = useEditor((s) => s.hotbar);
    const setHotbarSlot = useEditor((s) => s.setHotbarSlot);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const carried = useEditRoom((s) => s.carriedItem);
    const setActiveSlot = useEditRoom((s) => s.setActiveSlot);
    const setCarried = useEditRoom((s) => s.setCarriedItem);

    const room = useEditor((s) => s.room);
    return (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-auto">
            <div className="flex gap-1 bg-white/90 border border-neutral-200 rounded-sm shadow-md p-1 backdrop-blur-sm">
                {hotbar.map((slot, i) => (
                    <Slot
                        // biome-ignore lint/suspicious/noArrayIndexKey: hotbar slots are positional (slot index is the identity)
                        key={i}
                        index={i}
                        slot={slot}
                        room={room}
                        active={i === activeSlotIndex}
                        carrying={carried !== null}
                        onClick={() => {
                            if (carried) {
                                setHotbarSlot(i, carried);
                                setCarried(null);
                            } else {
                                setActiveSlot(i);
                            }
                        }}
                        onClear={() => setHotbarSlot(i, null)}
                    />
                ))}
            </div>
        </div>
    );
}

type SlotProps = {
    index: number;
    slot: HotbarSlot;
    room: ReturnType<typeof useEditor.getState>['room'];
    active: boolean;
    carrying: boolean;
    onClick: () => void;
    onClear: () => void;
};

function Slot({ index, slot, room, active, carrying, onClick, onClear }: SlotProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            onContextMenu={(e) => {
                e.preventDefault();
                onClear();
            }}
            className={`relative flex items-center justify-center rounded-sm cursor-pointer transition-colors ${
                active
                    ? 'bg-neutral-500 ring-1 ring-neutral-600'
                    : carrying
                      ? 'bg-blue-50 ring-1 ring-blue-300 hover:bg-blue-100'
                      : 'bg-neutral-100 hover:bg-neutral-200'
            }`}
            style={{ width: SLOT_SIZE, height: SLOT_SIZE }}
            title={slot ? inventoryItemDisplay(slot, room).title : `slot ${index + 1} (empty)`}
        >
            {slot && <InventoryItemIcon item={slot} size={ICON_SIZE} />}
            <span
                className={`absolute top-0.5 left-1 text-[9px] font-mono leading-none pointer-events-none ${
                    active ? 'text-white/90' : 'text-neutral-400'
                }`}
            >
                {index + 1}
            </span>
        </button>
    );
}

export { HOTBAR_SIZE };
