import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPanel, useChatEnabled, useChatPanel } from './chat/chat-panel';
import { useClient } from './stores/client-store';
import { Viewport } from './viewport';

import './editor.css';

// the debug dashboard is plain DOM mounted straight to the document (see client/ui/dashboard.ts); nothing to render here.

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

function PlayUI() {
    // embedding apps can call chat.setEnabled(ctx, false) to drop the panel and its keyboard openers.
    const chatEnabled = useChatEnabled();

    // mirrors the edit-ui handler but without the editor-enabled gate; play mode also owns the
    // backtick debug toggle since the editor's input loop doesn't run here.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isInputFocused()) return;
            if (e.key === '`') {
                e.preventDefault();
                useClient.getState().toggleDebugOpen();
                return;
            }
            if (chatEnabled && (e.key === '/' || e.key === 't' || e.key === 'Enter') && !useChatPanel.getState().isOpen) {
                e.preventDefault();
                useChatPanel.getState().open({ seed: e.key === '/' ? '/' : '' });
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [chatEnabled]);

    return (
        <div className="fixed inset-0 flex flex-col">
            <Viewport />
            {chatEnabled && <ChatPanel />}
        </div>
    );
}

// re-exported from bongle/engine-client; the play-mode boot template calls it directly between init and load.
export function mountPlayUI(container: HTMLElement): Root {
    const root = createRoot(container);
    root.render(<PlayUI />);
    return root;
}
