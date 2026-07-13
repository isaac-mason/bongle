// editor/ui/components/Tabs.tsx — VSCode-style tab strip for the code pane.

import { useOpenFile } from '../../stores/open-file';

export function Tabs() {
    const tabs = useOpenFile((s) => s.tabs);
    const active = useOpenFile((s) => s.active);
    const dirty = useOpenFile((s) => s.dirty);
    const { activate, close } = useOpenFile.getState();

    if (tabs.length === 0) return <div style={{ height: 26, borderBottom: '1px solid #000', flexShrink: 0 }} />;

    return (
        <div style={{ display: 'flex', height: 26, borderBottom: '1px solid #000', overflow: 'auto', flexShrink: 0 }}>
            {tabs.map((path) => {
                const on = path === active;
                const name = path.split('/').pop() ?? path;
                return (
                    <div
                        key={path}
                        onClick={() => activate(path)}
                        title={path}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '0 8px',
                            borderRight: '1px solid #000',
                            background: on ? '#000' : '#fff',
                            color: on ? '#fff' : '#000',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            font: '12px/1 ui-monospace, monospace',
                        }}
                    >
                        <span>{name}</span>
                        <span style={{ width: 8, textAlign: 'center' }}>{dirty[path] ? '●' : ''}</span>
                        <button
                            type="button"
                            title="close"
                            onClick={(e) => {
                                e.stopPropagation();
                                close(path);
                            }}
                            style={{
                                border: 'none',
                                background: 'transparent',
                                color: 'inherit',
                                cursor: 'pointer',
                                font: '13px/1 ui-monospace, monospace',
                                padding: 0,
                            }}
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
