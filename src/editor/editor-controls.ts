/**
 * centralizes editor keyboard shortcuts and control modes.
 * makes it easy to view and change keybindings in one place.
 */

import type { ControlMode } from './edit-room-store';

// Re-export control mode type for convenience
export type EditorControlMode = ControlMode;

export const TRANSFORM_GIZMO_KEYS = {
    translate: 'KeyT',
    rotate: 'KeyR',
    scale: 'KeyY',
    place: 'KeyU',
    grab: 'KeyI',
} as const;

// ── Transform Tool: Other Keys ───────────────────────────────────

export const TRANSFORM_OTHER_KEYS = {
    togglePivot: 'KeyP',
    toggleSpace: 'KeyX',
    commit: 'Enter', // placement mode only
    cancel: 'Escape', // placement mode + normal
    returnToInspect: 'Escape',
} as const;

// ── Selection Tools: Action Keys ────────────────────────────────

export const SELECTION_KEYS = {
    fill: 'KeyF',
    replace: 'Shift+KeyF',
    delete: 'Backspace',
    pick: 'KeyP',
    clearAll: 'KeyR',
} as const;

// ── Selection: Nudge Keys ──────────────────────────────────────

export const NUDGE_KEYS = {
    forward: 'ArrowUp',
    backward: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    up: 'BracketRight', // ]
    down: 'BracketLeft', // [
} as const;

// ── Inspector: Transform Mode Shortcuts ────────────────────────

export const INSPECT_KEYS = {
    toTranslate: 'KeyT',
    toRotate: 'KeyR',
    toScale: 'KeyY',
} as const;

// ── Library + Hotbar ─────────────────────────────────────────

export const LIBRARY_KEYS = {
    toggleLibrary: 'KeyE',
} as const;

// ── Tool Categories ────────────────────────────────────────────
// Hold a category key + tap digit 1..9 to jump to a slot in that
// category. Tap-alone cycles through tools in the category.

export const TOOL_CATEGORY_KEYS = {
    inspect: 'KeyV',
    transform: 'KeyG',
    select: 'KeyC',
    build: 'KeyB',
} as const;

export type ToolCategoryId = keyof typeof TOOL_CATEGORY_KEYS;

// digit codes 1..9 → hotbar slot indices 0..8
export const HOTBAR_NUMBER_KEYS = [
    'Digit1',
    'Digit2',
    'Digit3',
    'Digit4',
    'Digit5',
    'Digit6',
    'Digit7',
    'Digit8',
    'Digit9',
] as const;

// ── Helper: Format key code for display ────────────────────────

export function formatKeyLabel(code: string): string {
    // chord prefix: "Shift+KeyF" → "⇧F", "Alt+KeyT" → "⌥T"
    if (code.startsWith('Shift+')) return `⇧${formatKeyLabel(code.slice(6))}`;
    if (code.startsWith('Alt+')) return `⌥${formatKeyLabel(code.slice(4))}`;
    if (code.startsWith('Mod+')) return `⌘${formatKeyLabel(code.slice(4))}`;
    const labels: Record<string, string> = {
        KeyQ: 'Q',
        KeyT: 'T',
        KeyY: 'Y',
        KeyX: 'X',
        KeyP: 'P',
        KeyR: 'R',
        KeyF: 'F',
        KeyG: 'G',
        KeyH: 'H',
        KeyU: 'U',
        KeyI: 'I',
        KeyV: 'V',
        KeyM: 'M',
        KeyB: 'B',
        KeyC: 'C',
        Backspace: '⌫',
        Enter: '↵',
        Escape: 'esc',
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        BracketRight: ']',
        BracketLeft: '[',
    };
    return labels[code] ?? code.replace('Key', '');
}

// ── UI Data: All keybinds for help display ───────────────────────

export type KeybindGroup = {
    key: string;
    label: string;
    mode?: string;
};

export const EDITOR_KEYBINDINGS: Record<string, KeybindGroup[]> = {
    'tool categories': [
        { key: TOOL_CATEGORY_KEYS.inspect, label: 'inspect' },
        { key: TOOL_CATEGORY_KEYS.transform, label: 'transform' },
        { key: TOOL_CATEGORY_KEYS.select, label: 'select (box/magic)' },
        { key: TOOL_CATEGORY_KEYS.build, label: 'build (build/paint)' },
        { key: 'hold + 1-9', label: 'jump to slot in category' },
    ],
    'transform gizmo': [
        { key: TRANSFORM_GIZMO_KEYS.translate, label: 'translate' },
        { key: TRANSFORM_GIZMO_KEYS.rotate, label: 'rotate' },
        { key: TRANSFORM_GIZMO_KEYS.scale, label: 'scale' },
        { key: TRANSFORM_GIZMO_KEYS.grab, label: 'grab' },
    ],
    transform: [
        { key: TRANSFORM_OTHER_KEYS.togglePivot, label: 'pivot' },
        { key: TRANSFORM_OTHER_KEYS.toggleSpace, label: 'world/local' },
    ],
    selection: [
        { key: SELECTION_KEYS.fill, label: 'fill' },
        { key: SELECTION_KEYS.replace, label: 'replace' },
        { key: SELECTION_KEYS.delete, label: 'delete' },
        { key: SELECTION_KEYS.pick, label: 'pick' },
    ],
    nudge: [
        { key: NUDGE_KEYS.forward, label: 'fwd' },
        { key: NUDGE_KEYS.backward, label: 'back' },
        { key: NUDGE_KEYS.left, label: 'left' },
        { key: NUDGE_KEYS.right, label: 'right' },
        { key: NUDGE_KEYS.up, label: 'up' },
        { key: NUDGE_KEYS.down, label: 'down' },
    ],
    inspect: [
        { key: INSPECT_KEYS.toTranslate, label: '→ translate' },
        { key: INSPECT_KEYS.toRotate, label: '→ rotate' },
        { key: INSPECT_KEYS.toScale, label: '→ scale' },
    ],
    library: [
        { key: LIBRARY_KEYS.toggleLibrary, label: 'open/close library' },
        { key: '1-9', label: 'hotbar slot' },
        { key: 'wheel', label: 'cycle slots (build tool)' },
    ],
};
