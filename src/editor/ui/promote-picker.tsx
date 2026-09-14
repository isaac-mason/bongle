import { useEffect, useRef } from 'react';
import { SearchableSelect } from '../../client/ui/components';
import { useEditRoom } from '../edit-room-store';
import { prefabSelectItems } from './prefab-items';

/** the prefab picker behind "create node from selection"; the chosen prefab lands at the selection's centre, sized to it. */
export function PromotePicker() {
    const at = useEditRoom((s) => s.promotePicker);
    const setPromotePicker = useEditRoom((s) => s.setPromotePicker);
    const createFromSelection = useEditRoom((s) => s.createFromSelection);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (at) triggerRef.current?.click();
    }, [at]);
    if (!at) return null;
    return (
        <div className="absolute z-20" style={{ left: at.x, top: at.y }}>
            <SearchableSelect<string>
                items={prefabSelectItems(16)}
                onSelect={(id) => createFromSelection(id)}
                placeholder="prefab for the selection…"
                trigger={
                    <button
                        ref={triggerRef}
                        type="button"
                        onBlur={() => setPromotePicker(null)}
                        className="px-1.5 py-0.5 text-[10px] font-mono bg-surface border border-border text-fg"
                    >
                        create from selection
                    </button>
                }
            />
        </div>
    );
}
