import {
    addChild,
    addTrait,
    CharacterControllerTrait,
    cloneModel,
    ENVIRONMENT_OVERWORLD,
    env,
    findByName,
    findChildByName,
    getControlNode,
    getTrait,
    MeshTrait,
    matchmaking,
    model,
    onFrame,
    onJoin,
    PlayerControllerTrait,
    pack,
    query,
    resolveCamera,
    script,
    setEnvironment,
    setEnvironmentTime,
    setMeshLitMin,
    setMeshTint,
    setPosition,
    setQuaternion,
    setScale,
    sync,
    TransformTrait,
    trait,
    traverse,
    use,
    WorldTrait,
} from 'bongle';
import { RIG_6BONE_HAND_RIGHT, RIG_6BONE_HEAD } from 'bongle/avatar/rig';
import { blocks } from 'bongle/starter';
import { degreesToRadians, quat, type Vec3, type Vec4 } from 'mathcat';

matchmaking({ maxPlayers: 32 });

use(blocks);

const wizardModels = model('wizard-assets', {
    src: 'assets/wizard-game-assets.gltf',
});

const WizardTrait = trait('wizard', {
    color: [1, 1, 1, 1] as Vec4,
});

sync(WizardTrait, 'color', {
    schema: pack.list(pack.float32(), 4),
    pack: (t) => t.color,
    unpack: (v, t) => (t.color = v),
    rate: 'dirty',
});

script(WorldTrait, 'environment', (ctx) => {
    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
    setEnvironmentTime(ctx, 14);
});

script(WorldTrait, 'join', (ctx) => {
    if (!env.server) return;

    const palette: Vec4[] = [
        [0.9, 0.1, 0.1, 0.8], // red
        [0.2, 0.3, 0.95, 0.8], // blue
        [0.6, 0.15, 0.85, 0.8], // purple
    ];

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [8.5, 2, 8.5]);

        addTrait(playerNode, WizardTrait, { color: palette[Math.floor(Math.random() * palette.length)] });

        const staff = cloneModel(wizardModels.nodes.staff);
        staff.name = 'wizard:staff';
        const staffTransform = getTrait(staff, TransformTrait)!;
        setPosition(staffTransform, [0, 0, 0]);
        setQuaternion(staffTransform, quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(-35)));
        addChild(findByName(playerNode, RIG_6BONE_HAND_RIGHT)!, staff);

        const hat = cloneModel(wizardModels.nodes.hat);
        hat.name = 'wizard:hat';
        setPosition(getTrait(hat, TransformTrait)!, [0, 0.9, 0]);
        addChild(findByName(playerNode, RIG_6BONE_HEAD)!, hat);
    });
});

script(WorldTrait, 'viewmodel', (ctx) => {
    if (!env.client) return;

    const offset: Vec3 = [0.35, -0.5, -0.55];
    const sway = 0.05; // horizontal walk bob (m) at full speed
    const bounce = 0.05; // vertical footfall dip (m)
    const speedRef = 5; // walk speed (m/s) for full bob amplitude
    const airPerSpeed = 0.02; // airborne lift (m) per (m/s) of vertical velocity
    const airMax = 0.15; // airborne lift clamp (m)

    let bobBlend = 0; // eased walk amount (0..1)
    let air = 0; // eased airborne vertical offset (m); +y is down in this frame

    onFrame(ctx, ({ delta }) => {
        const { node: cameraNode } = resolveCamera(ctx);

        // build the viewmodel once, under whichever camera is current.
        let viewmodel = findChildByName(cameraNode, 'viewmodel:staff');
        if (!viewmodel) {
            viewmodel = cloneModel(wizardModels.nodes.staff);
            viewmodel.name = 'viewmodel:staff';
            const transform = getTrait(viewmodel, TransformTrait)!;
            setPosition(transform, offset);
            setScale(transform, [0.5, 0.5, 0.5]);
            // lay the staff forward along the view instead of standing it up.
            setQuaternion(transform, quat.setAxisAngle(quat.create(), [1, 0, 0], degreesToRadians(-20)));
            // floor the light so the held item stays readable in shadow.
            traverse(viewmodel, (node) => {
                const mesh = getTrait(node, MeshTrait);
                if (mesh) setMeshLitMin(mesh, 0.35);
            });
            addChild(cameraNode, viewmodel);
        }

        // visible only to the local player, only in first person.
        const controlNode = getControlNode(ctx);
        const playerController = controlNode && getTrait(controlNode, PlayerControllerTrait);
        const firstPerson = !!playerController && playerController.config.perspective === 'first';
        traverse(viewmodel, (node) => {
            const mesh = getTrait(node, MeshTrait);
            if (mesh) mesh.visible = firstPerson;
        });

        const characterController = controlNode && getTrait(controlNode, CharacterControllerTrait);
        if (!characterController) return;
        const { velocity, grounded, bobPhase } = characterController.state;

        // walk bob eases in with ground speed; airborne lift tracks vertical
        // velocity (clamped). both ease so stopping / landing don't snap.
        const speed = Math.hypot(velocity[0], velocity[2]);
        bobBlend += ((grounded ? Math.min(speed / speedRef, 1) : 0) - bobBlend) * Math.min(delta * 8, 1);
        const airTarget = grounded ? 0 : Math.max(-airMax, Math.min(airMax, -velocity[1] * airPerSpeed));
        air += (airTarget - air) * Math.min(delta * 10, 1);

        // sway side-to-side once per stride (`sin`), dip down each footfall
        // (`abs(sin)`, +y is down); the airborne lift rides on top.
        setPosition(getTrait(viewmodel, TransformTrait)!, [
            offset[0] + Math.sin(bobPhase) * sway * bobBlend,
            offset[1] + Math.abs(Math.sin(bobPhase)) * bounce * bobBlend + air,
            offset[2],
        ]);
    });
});

script(WorldTrait, 'wizard-visuals', (ctx) => {
    if (!env.client) return;

    const wizards = query(ctx, [WizardTrait]);

    onFrame(ctx, () => {
        for (const [wizard] of wizards.matches) {
            const hat = findChildByName(wizard._node, 'wizard:hat');
            if (!hat) continue;
            traverse(hat, (node) => {
                const mesh = getTrait(node, MeshTrait);
                if (mesh && mesh.tint[3] === 0) setMeshTint(mesh, wizard.color); // apply once (alpha 0 = untinted)
            });
        }
    });
});
