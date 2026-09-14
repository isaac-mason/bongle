import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Icons from '../../../icons';
import type { EngineClient } from '../../client/client';
import { extendDebugDashboard } from '../../client/ui/dashboard';
import { useClient } from '../../client/ui/stores/client-store';
import '../../client/ui/editor.css';
import { ChatPanel, useChatPanel } from '../../client/ui/chat/chat-panel';
import { Viewport } from '../../client/ui/viewport';
import { addEditorDebugOptions } from '../debug-options';
import { activeEditRoomStore, useEditRoom } from '../edit-room-store';
import { type EditorStore, useEditor } from '../editor-store';
import { loadEditorAssets } from '../icons';
import { installEditorClientListeners, setEditorEnabledForRoom } from '../lens';
import { stopRoom } from '../session';
import { ControlHints } from './control-hints';
import { EngineClientContext, useEngineClient } from './engine-client-context';
import { FlySpeedIndicator } from './fly-speed-indicator';
import { Hotbar } from './hotbar';
import { InventoryItemIcon } from './inventory-icon';
import { LeftToolbar } from './left-toolbar';
import { LibraryOverlay } from './library';
import { OrientationCube } from './orientation-cube';
import { RightPanel } from './right-panel';
import { ToolActions } from './tool-actions';
import { TopToolbar } from './top-toolbar';
import { ViewportContextMenu } from './viewport-context-menu';

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

// the viewBox maps NDC (-1..1) to 0..100 so the polyline stays pixel-aligned with the
// lasso tool's hit-test, which is also done in NDC.
function LassoOverlay() {
    const points = useEditRoom((s) => s.lasso?.points ?? null);
    if (!points || points.length < 2) return null;
    const path = points.map(([x, y]) => `${50 + x * 50},${50 - y * 50}`).join(' ');
    return (
        <svg
            className="absolute inset-0 pointer-events-none z-20"
            width="100%"
            height="100%"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
        >
            <title>lasso selection</title>
            <polyline
                points={path}
                fill="rgba(96, 165, 250, 0.12)"
                stroke="rgb(96, 165, 250)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

function ControlModeWidget() {
    const controlMode = useEditRoom((s) => s.controlMode);
    const setControlMode = useEditRoom((s) => s.setControlMode);

    return (
        <div className="absolute top-2 right-2 z-10 pointer-events-auto">
            <div className="flex bg-surface border border-border shadow-sm text-xs overflow-hidden">
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'fly' ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-surface-muted'}`}
                    onClick={() => setControlMode('fly')}
                    title="fly"
                >
                    <Icons.Send size={24} />
                </button>
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'orbit' ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-surface-muted'}`}
                    onClick={() => setControlMode('orbit')}
                    title="orbit"
                >
                    <Icons.Orbit size={24} />
                </button>
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'character' ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-surface-muted'}`}
                    onClick={() => setControlMode('character')}
                    title="character"
                >
                    <Icons.PersonStanding size={24} />
                </button>
            </div>
        </div>
    );
}

// chevron points toward the motion: left (pull the panel in) while collapsed, right (push it away) while open.
function RightPanelToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            title={collapsed ? 'show panel' : 'hide panel'}
            className="absolute top-1/2 -translate-y-1/2 right-0 z-10 flex items-center justify-center w-5 py-4 bg-surface border border-r-0 border-border text-fg-muted hover:bg-surface-muted hover:text-fg pointer-events-auto"
        >
            <Icons.ChevronRight size={12} className={collapsed ? 'rotate-180' : ''} />
        </button>
    );
}

// the first-person crosshair is the engine's play-mode HUD widget, driven by the
// PlayerControllerTrait that character mode installs, not editor chrome.
const RIGHT_PANEL_MIN = 180;
const RIGHT_PANEL_MAX = 600;
const RIGHT_PANEL_DEFAULT = 350;

// no lens: the player POV is the editor POV. with a lens, only the 'edit' POV shows chrome;
// switching to 'play' POV keeps the lens warm but hides it.
function editorChromeVisible(s: EditorStore): boolean {
    if (!s.room) return false;
    if (!s.playerEditStores[s.room.playerId]) return false;
    if (!s.lenses.get(s.room.playerId)) return true;
    return s.playerToView.get(s.room.playerId) === 'edit';
}

function EditUI() {
    const engine = useEngineClient();
    const editorEnabled = useEditor(editorChromeVisible);
    const showOrientationCube = useEditor((s) => s.showOrientationCube);
    const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT);
    const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

    const onRightPanelResize = useCallback((dx: number) => {
        setRightPanelWidth((w) => Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, w + dx)));
    }, []);

    // adapts editor defaults for touch once (a ref latch), so it never fights a user who
    // undoes either choice by hand afterwards.
    const inputMode = useClient((s) => s.inputMode);
    const adaptedForTouch = useRef(false);
    useEffect(() => {
        if (inputMode !== 'touch' || adaptedForTouch.current) return;
        adaptedForTouch.current = true;
        setRightPanelCollapsed(true);
        // fly is pointer-lock-only and inert on touch; only override the untouched 'fly'
        // default so a hybrid user who already picked orbit/character keeps their choice.
        const store = activeEditRoomStore();
        if (store.getState().controlMode === 'fly') store.getState().setControlMode('character');
    }, [inputMode]);

    // must work at the DOM layer: the editor script's per-frame onInput hook only fires
    // when the editor module is active for the room.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            // handled before the isInputFocused bail so cmd/ctrl+z works even while a tool-option
            // input holds focus; preventDefault stops the field's native text-undo.
            if (e.metaKey || e.ctrlKey) {
                const key = e.key.toLowerCase();
                if (key === 'z' || key === 'y') {
                    e.preventDefault();
                    const { room, playerEditStores } = useEditor.getState();
                    const store = room ? playerEditStores[room.playerId] : null;
                    if (store) {
                        if (key === 'y' || e.shiftKey) store.getState().redo();
                        else store.getState().undo();
                    }
                } else if (key === 's') {
                    const { room, roomMode, playerEditStores } = useEditor.getState();
                    if (roomMode === 'edit' && room) {
                        e.preventDefault();
                        playerEditStores[room.playerId]?.getState().save();
                    }
                }
                return;
            }

            if (isInputFocused()) return;

            // this is the single owner of plain backtick for every room the editor hosts: a
            // Shift+` lens on a play room also runs the editor's own input loop locally, so a
            // second toggle site here would double-fire and leave the panel looking dead.
            if (e.key === '`' && !e.shiftKey) {
                e.preventDefault();
                useClient.getState().toggleDebugOpen();
                return;
            }

            if (e.key === '`' && e.shiftKey) {
                e.preventDefault();
                const { room, playerEditStores, playerToView, lenses } = useEditor.getState();
                if (!room) return;
                const scriptAlive = !!playerEditStores[room.playerId];
                const editPov = !lenses.get(room.playerId) || playerToView.get(room.playerId) === 'edit';
                setEditorEnabledForRoom(room, !(scriptAlive && editPov));
                return;
            }

            if (e.key === 'Tab') {
                const { room, roomMode } = useEditor.getState();
                if (!room) return;
                e.preventDefault();
                if (roomMode === 'edit') {
                    activeEditRoomStore().getState().play();
                } else if (roomMode === 'play') {
                    stopRoom(engine, room.roomId);
                }
            }

            // while editor chrome is showing, Enter belongs to the tools (rename, accept, box-select,
            // placement commit); only '/' opens chat there. without chrome either key works.
            const opensChat = e.key === '/' || (e.key === 'Enter' && !editorChromeVisible(useEditor.getState()));
            if (opensChat && !useChatPanel.getState().isOpen) {
                e.preventDefault();
                useChatPanel.getState().open({ seed: e.key === '/' ? '/' : '' });
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [engine]);

    return (
        // colorScheme: dark makes native scrollbars and form controls match the editor theme;
        // it inherits to every scroll container mounted below this root.
        <div className="fixed inset-0 flex flex-col" style={{ colorScheme: 'dark' }}>
            <TopToolbar />

            <div className="flex-1 flex flex-row overflow-hidden">
                {editorEnabled && <LeftToolbar />}

                <div className="flex-1 relative overflow-hidden flex flex-col">
                    <Viewport />

                    {editorEnabled && (
                        <>
                            <LassoOverlay />
                            <ViewportContextMenu />
                            <ToolActions />
                            <ControlModeWidget />
                            <FlySpeedIndicator />
                            <ControlHints />
                            {showOrientationCube && <OrientationCube />}
                            <Hotbar />
                            <LibraryOverlay />
                        </>
                    )}

                    {/* rendered outside the editorEnabled gate so chat works in play mode too */}
                    <ChatPanel />

                    {editorEnabled && (
                        <RightPanelToggle collapsed={rightPanelCollapsed} onToggle={() => setRightPanelCollapsed((c) => !c)} />
                    )}
                </div>

                {editorEnabled && !rightPanelCollapsed && <RightPanel width={rightPanelWidth} onResize={onRightPanelResize} />}
            </div>

            {editorEnabled && <CarriedItemCursor />}
        </div>
    );
}

// clears itself when the store's carriedItem goes null.
function CarriedItemCursor() {
    const carried = useEditRoom((s) => s.carriedItem);
    const setCarried = useEditRoom((s) => s.setCarriedItem);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!carried) {
            setPos(null);
            return;
        }
        const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setCarried(null);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('keydown', onKey);
        };
    }, [carried, setCarried]);

    if (!carried || !pos) return null;
    return (
        <div className="fixed pointer-events-none z-50" style={{ left: pos.x + 12, top: pos.y + 12 }}>
            <div className="bg-surface/95 shadow-md border border-border p-1">
                <InventoryItemIcon item={carried} size={32} />
            </div>
        </div>
    );
}

// called from bongle/engine-client-editor's setup(state), which only the edit-mode boot
// template imports, so this chunk only ships in editor builds.
export function mountEditUI(state: EngineClient): Root {
    loadEditorAssets(state);
    installEditorClientListeners();
    extendDebugDashboard(addEditorDebugOptions);
    const root = createRoot(state.domElement);
    root.render(
        <EngineClientContext.Provider value={state}>
            <EditUI />
        </EngineClientContext.Provider>,
    );
    return root;
}

export { useClient } from '../../client/ui/stores/client-store';
export { useEditRoom } from '../edit-room-store';
// script consumers and pane components import the stores from this file for convenience.
export { useEditor } from '../editor-store';
