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
          /** the user may edit this existing avatar (save a new version of it): the
           *  platform resolved `?edit=<slug>` AND confirmed the user is on its team
           *  (the editor can't check team membership — it's platform auth). When
           *  set, Save prompts for a version name prefilled "new version of <name>".
           *  Absent for a brand-new avatar or a non-member. */
          canEdit?: boolean;
      }
    | {
          /** join someone else's live edit session as a guest. The platform
           *  resolved the invite (/api/edit/join) and hands over the relay ws
           *  url (token baked in); the editor connects to it as a remote client. */
          kind: 'joinEdit';
          url: string;
      };

/** editor → platform. */
export type EditorMessage =
    | { type: 'bongle:ready' }
    /** hand back the game-save source zip for the platform to persist. */
    | { type: 'bongle:save'; payload: Uint8Array }
    /** hand back the built game-build bundle.zip for the platform to upload. */
    | { type: 'bongle:build'; payload: Uint8Array }
    /** hand back the exported avatar (compiled .glb + .bbmodel source) for the
     *  platform to upload (editor-initiated from the "editing X" window). */
    | { type: 'bongle:avatar-export'; glb: Uint8Array; bbmodel: string; name: string }
    /** the host asks the platform to open this session to multiplayer. The
     *  platform calls /api/edit/host (it owns the session) and replies with a
     *  multiplayer-opened. `region` is the host's picked region. */
    | { type: 'bongle:open-multiplayer'; region?: string }
    /** the user asked to leave the editor. The editor never navigates itself
     *  (it may be a cross-origin iframe); the platform routes back to bongle.io. */
    | { type: 'bongle:exit' };

/** platform → editor. */
export type PlatformMessage =
    | { type: 'bongle:init'; intent: PlatformIntent }
    /** outcome of the editor's last hand-back (save/build/avatar-export). */
    | { type: 'bongle:result'; of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string }
    /** answer to open-multiplayer: the relay ws url the host connects to + the
     *  ready-to-share invite link. */
    | { type: 'bongle:multiplayer-opened'; url: string; shareUrl: string }
    | { type: 'bongle:multiplayer-failed'; message: string };

/** the result payload the editor surfaces to the user. */
export type PlatformResult = { of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string };
