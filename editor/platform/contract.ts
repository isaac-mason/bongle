// editor/platform/contract.ts — the postMessage contract between the editor and
// its embedding platform (the editor mounted in an iframe; the platform is the
// parent window). The editor is a purpose-agnostic shell: the platform declares
// what it's FOR via an `intent`, and the editor hands finished payloads back for
// the platform to persist/upload (the platform owns auth + storage; the editor
// never holds a token).
//
// Kept deliberately small + versionless-for-now: a discriminated `intent.kind`
// is the extension point (game, avatar, … more later).

/** what the platform mounted the editor to do. */
export type PlatformIntent =
    | {
          kind: 'game';
          /** the game-save source zip to open into OPFS (absent = new/empty project). */
          save?: Uint8Array;
          /** a project file to open in the code editor on boot. */
          openPath?: string;
          /** our account avatar's glb URL, so we play/edit the game as ourselves
           *  (the local player wears it). Absent → a random sample avatar. */
          avatarUrl?: string;
      }
    | {
          kind: 'avatar';
          /** the .bbmodel source (JSON text) to edit in Blockbench (absent = new). */
          bbmodel?: string;
          /** display name / id for the avatar being edited. */
          name?: string;
      };

/** editor → platform. */
export type EditorMessage =
    | { type: 'bongle:ready' }
    /** hand back the game-save source zip for the platform to persist. */
    | { type: 'bongle:save'; payload: Uint8Array }
    /** hand back the built game-version bundle.zip for the platform to upload. */
    | { type: 'bongle:build'; payload: Uint8Array }
    /** hand back the exported avatar (compiled .glb + .bbmodel source) for the
     *  platform to upload (editor-initiated from the "editing X" window). */
    | { type: 'bongle:avatar-export'; glb: Uint8Array; bbmodel: string; name: string };

/** platform → editor. */
export type PlatformMessage =
    | { type: 'bongle:init'; intent: PlatformIntent }
    /** outcome of the editor's last hand-back (save/build/avatar-export). */
    | { type: 'bongle:result'; of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string };

/** the result payload the editor surfaces to the user. */
export type PlatformResult = { of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string };
