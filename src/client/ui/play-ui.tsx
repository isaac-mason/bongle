import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPanel, useChatEnabled, useChatPanel } from './chat/chat-panel';
import { useClient } from './stores/client-store';
import { Viewport } from './viewport';

import './editor.css';

// the debug dashboard is vanilla dashcat mounted straight to the DOM (see
// client/ui/dashboard.ts), toggled by backtick via the `debugOpen` store bit.
// nothing to render in the React tree here.

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

function PlayUI() {
    // apps embedding the engine as a pure display surface call
    // `chat.setEnabled(ctx, false)`; drop the panel and its keyboard openers.
    const chatEnabled = useChatEnabled();

    // `t` / `Enter` open chat (no seed); `/` opens chat seeded with a slash so
    // the user can immediately type a command. mirrors the edit-ui handler but
    // without the editor-enabled gate (edit mode uses Enter only, no `t`).
    // backtick toggles the debug panel, the editor's backtick chord lives in its
    // own input loop, which doesn't run in play, so play mode owns this here.
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

/**
 * Mount the play-mode UI shell into `container`. No editor chrome, just the
 * viewport. Re-exported from `bongle/engine-client`; the play-mode boot
 * template calls it directly between init and load.
 */
export function mountPlayUI(container: HTMLElement): Root {
    const root = createRoot(container);
    root.render(<PlayUI />);
    return root;
}
