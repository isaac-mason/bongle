import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPanel, useChatPanel } from './chat-panel';
import { Viewport } from './viewport';

import './editor.css';

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

function PlayUI() {
    // `t` / `Enter` open chat (no seed); `/` opens chat seeded with a slash so
    // the user can immediately type a command. mirrors the edit-ui handler but
    // without the editor-enabled gate (edit mode uses Enter only, no `t`).
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isInputFocused()) return;
            if ((e.key === '/' || e.key === 't' || e.key === 'Enter') && !useChatPanel.getState().isOpen) {
                e.preventDefault();
                useChatPanel.getState().open({ seed: e.key === '/' ? '/' : '' });
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    return (
        <div className="fixed inset-0 flex flex-col">
            <Viewport />
            <ChatPanel />
        </div>
    );
}

/**
 * Mount the play-mode UI shell into `container`. No editor chrome — just the
 * viewport. Re-exported from `bongle/engine-client`; the play-mode boot
 * template calls it directly between init and load.
 */
export function mountPlayUI(container: HTMLElement): Root {
    const root = createRoot(container);
    root.render(<PlayUI />);
    return root;
}
