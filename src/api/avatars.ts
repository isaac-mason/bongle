// api/avatars.ts, script-facing avatar API: source, load, assign, release.
//
//   - sampleAvatars, pull an opaque batch from the `ServerDriver.avatars` host capability
//   - loadAvatar, acquire + ensure a resolved avatar's model; +1 refcount (runtime; bundled = ensure-only)
//   - assignAvatar, point a node's CharacterTrait at an already-loaded model (no refcount)
//   - releaseAvatar, drop the refcount; bytes freed only when the last holder releases
//
// `loadAvatar` MUST precede `assignAvatar` for runtime avatars: acquire registers
// the resource entry that ensure + the rig reconciler need (bundled entries are
// codegen-hydrated, so they can be assigned directly). Every `loadAvatar` balances
// with exactly one `releaseAvatar` per holder; the shared per-modelId refcount means
// a player and an NPC on the same avatar = one load, freed only when both release.
//
// The load/assign internals live in core/avatar/model and are shared with the engine
// player-join path (server/avatars); this module is the script-facing surface.

import { RIG_TYPE_6BONE } from "../../avatar/rig";
import type { ResolvedAvatar } from 'bongle/interface';
import { acquireAvatarModel } from '../core/avatar/model';
import * as Resources from '../core/resources';
import type { ScriptContext } from '../core/scene/scripts';

// `assignAvatar` is shared with the engine player path, so it lives in core; surface
// it here as part of the script-facing API.
export { assignAvatar } from '../core/avatar/model';

// Rig contract (bone names, required/attach node lists, validator). Also reachable
// via the `bongle/avatar/rig` subpath; surfaced here so scripts can resolve bones by
// name (`findByName(playerNode, RIG_6BONE_HAND_RIGHT)`) straight off bare `bongle`.
export * from "../../avatar/rig";

/**
 * Pull a batch of avatars for populating NPCs. Opaque + unordered + non-stable,
 * the host owns what's in it and may return fewer than you'd like (or none).
 * Resolves to an empty array off-server (or when the host's pool is empty), so
 * callers just fall back to their default avatar. Bulk: call once and round-robin
 * the result onto your NPCs, not per-NPC.
 */
export function sampleAvatars(ctx: ScriptContext): Promise<ResolvedAvatar[]> {
    return ctx.server ? ctx.server.state.driver.avatars.sample() : Promise.resolve([]);
}

/**
 * Load a resolved avatar's model (acquire + ensure) and bump its refcount (runtime;
 * bundled = ensure-only). Returns `{ modelId, rigType }` to hand to `assignAvatar`.
 * Balance each call with one `releaseAvatar`. Must precede `assignAvatar` for runtime
 * avatars (acquire registers the entry the reconciler loads from).
 */
export function loadAvatar(ctx: ScriptContext, avatar: ResolvedAvatar): { modelId: string; rigType: string } {
    const resources = ctx._runtime?.resources;
    if (!resources) {
        // No runtime resources (degenerate context), return identity so a bundled
        // assign still works; runtime payloads simply won't load here.
        const rigType = avatar.source === 'runtime' ? (avatar.rigType ?? RIG_TYPE_6BONE) : RIG_TYPE_6BONE;
        return { modelId: avatar.modelId, rigType };
    }
    return acquireAvatarModel(resources, avatar);
}

/**
 * Drop the runtime refcount for an avatar model, call on NPC despawn / round
 * reset so the pool doesn't accrete. No-op for bundled models or unknown ids.
 */
export function releaseAvatar(ctx: ScriptContext, modelId: string): void {
    const resources = ctx._runtime?.resources;
    if (resources) Resources.releaseRuntimeModel(resources, modelId);
}

// Small bundled word pools so ambient NPCs read as handles, not "Dummy 3".
// Wholly separate from avatar sourcing, games may use them, ignore them, or
// bring their own lists.
const ADJECTIVES = [
    'Agile', 'Airy', 'Alert', 'Amber', 'Ample', 'Aqua', 'Arctic', 'Ashen',
    'Autumn', 'Azure', 'Balmy', 'Beaming', 'Blissful', 'Blue', 'Bold', 'Bouncy',
    'Brave', 'Breezy', 'Bright', 'Brisk', 'Bubbly', 'Bumpy', 'Bushy', 'Buzzy',
    'Calm', 'Charming', 'Cheeky', 'Cheery', 'Chill', 'Chirpy', 'Chunky', 'Classic',
    'Clever', 'Cloudy', 'Comfy', 'Cool', 'Coral', 'Cosmic', 'Cozy', 'Craggy',
    'Creamy', 'Crimson', 'Crisp', 'Curious', 'Curly', 'Dainty', 'Dandy', 'Dapper',
    'Daring', 'Dashing', 'Dazzling', 'Dewy', 'Dreamy', 'Dusky', 'Eager', 'Earnest',
    'Easy', 'Emerald', 'Epic', 'Fancy', 'Feisty', 'Fiery', 'Fine', 'Fizzy',
    'Fleet', 'Fluffy', 'Fond', 'Frosty', 'Fuzzy', 'Gentle', 'Giddy', 'Glad',
    'Gleaming', 'Glossy', 'Golden', 'Grassy', 'Happy', 'Hardy', 'Hazel', 'Hearty',
    'Hidden', 'Honest', 'Humble', 'Icy', 'Ideal', 'Ivory', 'Jade', 'Jaunty',
    'Jolly', 'Jovial', 'Joyful', 'Keen', 'Kind', 'Lanky', 'Lavish', 'Lazy',
    'Leafy', 'Lemony', 'Lilac', 'Limber', 'Lively', 'Loud', 'Lucky', 'Lush',
    'Mellow', 'Merry', 'Mighty', 'Mild', 'Minty', 'Misty', 'Modest', 'Mossy',
    'Muddy', 'Nimble', 'Noble', 'Nutty', 'Olive', 'Perky', 'Placid', 'Plucky',
    'Plush', 'Polished', 'Prancing', 'Prickly', 'Proud', 'Quick', 'Quiet', 'Quirky',
    'Radiant', 'Rapid', 'Robust', 'Rosy', 'Ruby', 'Rustic', 'Rusty', 'Sandy',
    'Scarlet', 'Serene', 'Shady', 'Sharp', 'Shiny', 'Silky', 'Silly', 'Sleek',
    'Sleepy', 'Smooth', 'Snappy', 'Snowy', 'Soft', 'Solar', 'Sparkly', 'Speedy',
    'Spicy', 'Spirited', 'Sprightly', 'Spry', 'Sturdy', 'Sunny', 'Swift', 'Tawny',
    'Teal', 'Tender', 'Thrifty', 'Tidy', 'Tiny', 'Toasty', 'Trusty', 'Twinkly',
    'Valiant', 'Velvet', 'Vivid', 'Warm', 'Whimsical', 'Windy', 'Wise', 'Witty',
    'Woolly', 'Zany', 'Zesty', 'Zippy',
];

const NOUNS = [
    'Acorn', 'Alpaca', 'Anchor', 'Antelope', 'Apple', 'Apricot', 'Arrow', 'Ash',
    'Aspen', 'Atlas', 'Aurora', 'Badger', 'Bagel', 'Bamboo', 'Basil', 'Beacon',
    'Bean', 'Bear', 'Beaver', 'Bell', 'Berry', 'Birch', 'Bird', 'Biscuit',
    'Bison', 'Bloom', 'Bluejay', 'Bobcat', 'Bolt', 'Boulder', 'Bramble', 'Branch',
    'Breeze', 'Brick', 'Bronze', 'Brook', 'Bud', 'Bunny', 'Button', 'Cactus',
    'Cake', 'Camel', 'Canary', 'Candy', 'Canyon', 'Cashew', 'Cat', 'Cave',
    'Cedar', 'Cheetah', 'Cherry', 'Chime', 'Chipmunk', 'Cider', 'Cinder', 'Cliff',
    'Cloud', 'Clover', 'Cobalt', 'Cobra', 'Cocoa', 'Coil', 'Comet', 'Compass',
    'Cookie', 'Copper', 'Coral', 'Cotton', 'Cougar', 'Cove', 'Coyote', 'Crab',
    'Crane', 'Crayon', 'Creek', 'Cricket', 'Crow', 'Crown', 'Crystal', 'Cub',
    'Cube', 'Custard', 'Daisy', 'Dawn', 'Deer', 'Delta', 'Dew', 'Dingo',
    'Dolphin', 'Domino', 'Donkey', 'Donut', 'Dove', 'Dragon', 'Drum', 'Duck',
    'Dumpling', 'Dune', 'Dusk', 'Eagle', 'Eclipse', 'Eel', 'Egret', 'Elk',
    'Ember', 'Fable', 'Falcon', 'Fawn', 'Feather', 'Fern', 'Ferret', 'Fig',
    'Finch', 'Fire', 'Firefly', 'Flame', 'Flamingo', 'Flare', 'Flute', 'Forest',
    'Fox', 'Frog', 'Frost', 'Galaxy', 'Gale', 'Garnet', 'Gazelle', 'Gecko',
    'Geyser', 'Ghost', 'Giraffe', 'Glacier', 'Glade', 'Glow', 'Gopher', 'Goose',
    'Grape', 'Grove', 'Hamster', 'Harbor', 'Hare', 'Hawk', 'Haze', 'Hazel',
    'Hedgehog', 'Heron', 'Hill', 'Hippo', 'Honey', 'Hornet', 'Hound', 'Ibis',
    'Ice', 'Iguana', 'Impala', 'Iris', 'Ivy', 'Jackal', 'Jade', 'Jaguar',
    'Jam', 'Jay', 'Jazz', 'Jelly', 'Jet', 'Jungle', 'Juniper', 'Kelp',
    'Kestrel', 'Kettle', 'Kite', 'Kitten', 'Koala', 'Ladybug', 'Lagoon', 'Lake',
    'Lantern', 'Lark', 'Lava', 'Leaf', 'Lemon', 'Lemur', 'Leopard', 'Lily',
    'Lime', 'Lion', 'Llama', 'Lobster', 'Lotus', 'Lynx', 'Macaw', 'Magpie',
    'Mango', 'Mantis', 'Maple', 'Marble', 'Marmot', 'Meadow', 'Meerkat', 'Meteor',
    'Mink', 'Mint', 'Mist', 'Mole', 'Mongoose', 'Moon', 'Moose', 'Mosaic',
    'Moss', 'Moth', 'Mountain', 'Mouse', 'Muffin', 'Mule', 'Narwhal', 'Nebula',
    'Neon', 'Nest', 'Newt', 'Noodle', 'Nova', 'Nugget', 'Nutmeg', 'Oak',
    'Oasis', 'Ocean', 'Ocelot', 'Olive', 'Onyx', 'Opal', 'Orbit', 'Orca',
    'Orchid', 'Osprey', 'Ostrich', 'Otter', 'Owl', 'Paddle', 'Panda', 'Panther',
    'Parrot', 'Peach', 'Peacock', 'Peanut', 'Pear', 'Pebble', 'Pecan', 'Pelican',
    'Penguin', 'Pepper', 'Petal', 'Pheasant', 'Pickle', 'Pigeon', 'Piglet', 'Pine',
    'Pixel', 'Planet', 'Plum', 'Pluto', 'Pond', 'Pony', 'Popcorn', 'Poppy',
    'Possum', 'Prairie', 'Prawn', 'Pretzel', 'Prism', 'Puffin', 'Puma', 'Pumpkin',
    'Puzzle', 'Python', 'Quail', 'Quartz', 'Quasar', 'Rabbit', 'Raccoon', 'Radish',
    'Rain', 'Raisin', 'Ram', 'Rapids', 'Raven', 'Ray', 'Reed', 'Reef',
    'Ridge', 'River', 'Robin', 'Rocket', 'Rooster', 'Root', 'Rose', 'Ruby',
    'Sage', 'Salmon', 'Salt', 'Sand', 'Scout', 'Seal', 'Sequoia', 'Serval',
    'Shadow', 'Shark', 'Sheep', 'Shell', 'Shore', 'Shrew', 'Silver', 'Skunk',
    'Sky', 'Sloth', 'Snail', 'Snow', 'Sparrow', 'Spark', 'Sphinx', 'Spice',
    'Spirit', 'Sprout', 'Spruce', 'Squid', 'Squirrel', 'Star', 'Starling', 'Stingray',
    'Stoat', 'Stone', 'Stork', 'Storm', 'Stream', 'Sugar', 'Summer', 'Summit',
    'Sunset', 'Swan', 'Tango', 'Tapir', 'Teal', 'Thicket', 'Thistle', 'Thorn',
    'Thunder', 'Tide', 'Tiger', 'Timber', 'Toad', 'Topaz', 'Toucan', 'Trout',
    'Tulip', 'Tundra', 'Turtle', 'Twig', 'Valley', 'Velvet', 'Vine', 'Violet',
    'Vole', 'Volt', 'Vulture', 'Waffle', 'Wallaby', 'Walnut', 'Walrus', 'Warbler',
    'Wave', 'Weasel', 'Whale', 'Whisper', 'Willow', 'Winter', 'Wisp', 'Wolf',
    'Wombat', 'Wonder', 'Woodpecker', 'Wren', 'Yak', 'Yam', 'Zebra', 'Zen',
];

function pick(words: readonly string[]): string {
    return words[(Math.random() * words.length) | 0]!;
}

/** A plausible display name for an ambient NPC, in the shape
 *  `AdjectiveNoun12345` (e.g. `BluePanda102837`). */
export function randomDisplayName(): string {
    const number = 100000 + ((Math.random() * 900000) | 0);
    return `${pick(ADJECTIVES)}${pick(NOUNS)}${number}`;
}
