import type { SearchableSelectItem } from '../../client/ui/components';
import { registry } from '../../core/registry';
import { PrefabThumb } from './prefab-thumb';

/** every registered prefab as a searchable item, thumbnail leading, sorted by id. */
export function prefabSelectItems(thumbSize: number): SearchableSelectItem<string>[] {
    const prefabDefs = registry.prefabs.byId;
    return Array.from(prefabDefs.keys())
        .sort()
        .map((id) => {
            const def = prefabDefs.get(id);
            const name = def?.name ?? id;
            const leading = <PrefabThumb key={id} prefabId={id} size={thumbSize} className="overflow-hidden shrink-0" />;
            return { id, label: name, sublabel: name === id ? undefined : id, keywords: def?.tags, leading };
        });
}
