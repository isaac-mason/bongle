// editor/ui/components/CodePane.tsx — the code editor window: a self-contained
// mini-IDE with its own file sidebar, VSCode-style tabs, and Monaco. Clicking a
// file (here or in the standalone file browser) opens a tab.

import type { Filesystem } from '../../fs';
import { FileTree } from './FileTree';
import { Monaco } from './Monaco';
import { Tabs } from './Tabs';

export function CodePane({ fs }: { fs: Filesystem }) {
    return (
        <div style={{ display: 'flex', height: '100%' }}>
            <div style={{ width: 170, borderRight: '1px solid #000', overflow: 'auto', flexShrink: 0 }}>
                <FileTree fs={fs} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Tabs />
                <div style={{ flex: 1, minHeight: 0 }}>
                    <Monaco fs={fs} />
                </div>
            </div>
        </div>
    );
}
