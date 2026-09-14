import { useEffect, useRef } from 'react';
import { SearchableSelect } from '../../client/ui/components';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { traitSelectItems } from './trait-items';

/** the add-trait picker behind the node menus; opens where the menu was, at client coordinates. */
export function TraitPicker() {
    const picker = useEditRoom((s) => s.traitPicker);
    const setTraitPicker = useEditRoom((s) => s.setTraitPicker);
    const addTrait = useEditRoom((s) => s.addTrait);
    const scene = useEditor((s) => s.room?.scene ?? null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (picker) triggerRef.current?.click();
    }, [picker]);
    const node = picker && scene ? scene.idToNode.get(picker.nodeId) : undefined;
    if (!picker || !node) return null;
    return (
        <div className="fixed z-50" style={{ left: picker.clientX, top: picker.clientY }}>
            <SearchableSelect<string>
                items={traitSelectItems(node)}
                onSelect={(id) => {
                    addTrait(picker.nodeId, id);
                    setTraitPicker(null);
                }}
                placeholder="search traits…"
                trigger={
                    <button
                        ref={triggerRef}
                        type="button"
                        onBlur={() => setTraitPicker(null)}
                        className="px-1.5 py-0.5 text-[10px] font-mono bg-surface border border-border text-fg"
                    >
                        add trait
                    </button>
                }
            />
        </div>
    );
}
