// interface/editor.ts — the editor⇄platform boundary contract. A peer of
// client.ts / server.ts (the engine⇄host boundary): the postMessage protocol
// between the editor (mounted in an iframe) and its embedding platform (the
// parent window). The editor is a purpose-agnostic shell — the platform declares
// what it's FOR via an `intent`, and the editor hands finished payloads back for
// the platform to persist/upload. The platform owns auth + storage; the editor
// never holds a token.
//
// STABILITY CONTRACT (this is what lets one latest-wins platform drive many
// pinned editor bundle versions — see plan-in-browser-editor):
//   1. Evolve ADDITIVELY. Add new intent `kind`s / message `type`s / OPTIONAL
//      fields; never remove or repurpose. Major bumps only for genuine breaks,
//      and then the platform carries both majors through a transition window.
//   2. Payloads stay OPAQUE to the platform. Every payload is `Uint8Array` — the
//      platform stores/forwards bytes tagged with a version, it never parses a
//      save/build's internals. The churny stuff (engine api, scene format,
//      bundler, pipeline) lives BELOW this line, inside the versioned artifact.
//   3. No editor internals leak across the boundary (no engine version, scene
//      format, bundler flags). Keep the verbs coarse + capability-shaped.

/** Semver of THIS editor⇄platform contract (distinct from the engine⇄game
 *  INTERFACE_VERSION — they evolve independently). The editor announces its
 *  value in `bongle:ready`; the platform announces its own in `bongle:init`, so
 *  either side can warn / degrade when the peer's major differs. */
export const EDITOR_INTERFACE_VERSION = '1.0.0';

/** whether two EDITOR_INTERFACE_VERSION values can bridge. Starts STRICT — exact
 *  match — while the contract is young; loosen to same-major once it stabilises
 *  (minor/patch changes are additive by rule #1). A missing version, a bundle
 *  predating the handshake, is treated as compatible (best effort, don't warn). */
export function editorInterfaceCompatible(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return true;
    return a === b;
}

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
    /** editor booted + listening. `version` is EDITOR_INTERFACE_VERSION of the
     *  editor bundle (optional until every live bundle announces it). */
    | { type: 'bongle:ready'; version?: string }
    /** hand back the game-save source zip for the platform to persist. */
    | { type: 'bongle:save'; payload: Uint8Array }
    /** hand back the built game-build bundle.zip for the platform to upload.
     *  `source` is the project source zip (same as bongle:save) so the platform
     *  can snapshot it as a game_version + record the build's provenance. */
    | { type: 'bongle:build'; payload: Uint8Array; source?: Uint8Array }
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
    /** configure the editor for its purpose. `version` is the platform's
     *  EDITOR_INTERFACE_VERSION (optional until wired). */
    | { type: 'bongle:init'; version?: string; intent: PlatformIntent }
    /** outcome of the editor's last hand-back (save/build/avatar-export). */
    | { type: 'bongle:result'; of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string }
    /** answer to open-multiplayer: the relay ws url the host connects to + the
     *  ready-to-share invite link. */
    | { type: 'bongle:multiplayer-opened'; url: string; shareUrl: string }
    | { type: 'bongle:multiplayer-failed'; message: string };

/** the result payload the editor surfaces to the user. */
export type PlatformResult = { of: 'save' | 'build' | 'avatar-export'; ok: boolean; message?: string };
