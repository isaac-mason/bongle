// editor/ui/components/Tabs.tsx — VSCode-style tab strip for the code pane.

import { useOpenFile } from '../../stores/open-file';

export function Tabs() {
    const tabs = useOpenFile((s) => s.tabs);
    const active = useOpenFile((s) => s.active);
    const dirty = useOpenFile((s) => s.dirty);
    const { activate, close } = useOpenFile.getState();

    if (tabs.length === 0) return <div className="h-[26px] shrink-0 border-b border-border" />;

    return (
        <div className="flex h-[26px] shrink-0 overflow-auto border-b border-border">
            {tabs.map((path) => {
                const on = path === active;
                const name = path.split('/').pop() ?? path;
                return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: tab row is pointer chrome.
                    <div
                        key={path}
                        onClick={() => activate(path)}
                        title={path}
                        className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-border px-2 font-mono text-xs leading-none ${
                            on ? 'bg-accent text-on-accent' : 'bg-surface text-fg'
                        }`}
                    >
                        <span>{name}</span>
                        <span className="w-2 text-center">{dirty[path] ? '●' : ''}</span>
                        <button
                            type="button"
                            title="close"
                            onClick={(e) => {
                                e.stopPropagation();
                                close(path);
                            }}
                            className="cursor-pointer border-none bg-transparent p-0 font-mono text-[13px] leading-none text-inherit"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
