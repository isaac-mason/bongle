import { HierarchyPanel } from '../hierarchy';

// no CollapsiblePane wrapper: HierarchyPanel owns its own header and is always visible.
export function HierarchyPane() {
    return <HierarchyPanel />;
}
