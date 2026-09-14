import type { SearchableSelectItem } from '../../client/ui/components';
import { registry } from '../../core/registry';
import type { Node } from '../../core/scene/scene-tree';
import { SpriteIcon } from './sprite-icon';

/** every registered trait the node does not carry yet, icon leading. */
export function traitSelectItems(node: Node): SearchableSelectItem<string>[] {
    return [...registry.traits.handles.values()]
        .filter((h) => node.traits[h.slot] === undefined)
        .map((h) => ({
            id: h.id,
            label: h.def.name,
            sublabel: h.def.name === h.id ? undefined : h.id,
            leading: h.def.icon ? <SpriteIcon key={h.id} id={h.def.icon} size={12} /> : undefined,
        }));
}
