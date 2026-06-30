import { HierarchyPanel } from '../hierarchy';

/**
 * thin wrapper around <HierarchyPanel> for use inside <RightPanel>.
 * the inner panel owns its own header, so no CollapsiblePane wrapper here,
 * hierarchy is always visible.
 */
export function HierarchyPane() {
    return <HierarchyPanel />;
}
