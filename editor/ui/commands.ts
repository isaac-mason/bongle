// editor/ui/commands.ts — the command palette's action registry (Cmd/Ctrl+Shift+P).
//
// A command is a titled, categorised action with an optional availability guard.
// Adding one is a single entry here — `run` reaches runtime state through the
// stores (useEditor.getState() etc.) and the passed-in context. The palette
// (CommandPalette.tsx) filters by `when`, fuzzy-matches "category: title", and
// invokes `run` on accept.

import type { Filesystem } from '../fs';
import { formatActiveDocument, hasActiveTsModel, organizeActiveImports } from './components/Monaco';

export type CommandCtx = { fs: Filesystem };

export type Command = {
    /** stable id, also the palette list key. */
    id: string;
    /** primary label shown in the palette. */
    title: string;
    /** grouping label shown dimmed on the right (also fuzzy-matched). */
    category: string;
    /** availability gate — commands whose guard returns false are hidden. */
    when?: () => boolean;
    run: (ctx: CommandCtx) => void | Promise<void>;
};

export const COMMANDS: Command[] = [
    {
        id: 'editor.formatDocument',
        title: 'Format Document',
        category: 'Editor',
        when: hasActiveTsModel,
        run: () => formatActiveDocument(),
    },
    {
        id: 'editor.organizeImports',
        title: 'Organize Imports',
        category: 'Editor',
        when: hasActiveTsModel,
        run: () => organizeActiveImports(),
    },
];
