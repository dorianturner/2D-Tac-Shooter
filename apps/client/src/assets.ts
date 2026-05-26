export type ImageAssetId =
  | "playerBlue"
  | "playerOrange"
  | "weaponAssault"
  | "weaponSniper"
  | "weaponShotgun"
  | "camera"
  | "soundSensor"
  | "molotov"
  | "smoke"
  | "deployableWall"
  | "muzzleFlash"
  | "bulletImpact";

export interface ImageAssetDefinition {
  id: ImageAssetId;
  key: string;
  /** Drop a PNG under apps/client/public and set this to its public path, e.g. "/assets/sprites/player-blue.png". */
  path?: string;
  examplePath: string;
  recommended: string;
}

export const imageAssets: Record<ImageAssetId, ImageAssetDefinition> = {
  playerBlue: {
    id: "playerBlue",
    key: "sprite.player.blue",
    path: "/assets/sprites/player-blue.png",
    examplePath: "/assets/sprites/player-blue.png",
    recommended: "Transparent PNG, 64x64, top-down operator/icon facing right."
  },
  playerOrange: {
    id: "playerOrange",
    key: "sprite.player.orange",
    path: "/assets/sprites/player-orange.png",
    examplePath: "/assets/sprites/player-orange.png",
    recommended: "Transparent PNG, 64x64, top-down operator/icon facing right."
  },
  weaponAssault: {
    id: "weaponAssault",
    key: "sprite.weapon.assault",
    path: "/assets/sprites/assault-rifle.png",
    examplePath: "/assets/sprites/assault-rifle.png",
    recommended: "Transparent PNG, weapon facing right."
  },
  weaponSniper: {
    id: "weaponSniper",
    key: "sprite.weapon.sniper",
    path: "/assets/sprites/sniper-rifle.png",
    examplePath: "/assets/sprites/sniper-rifle.png",
    recommended: "Transparent PNG, weapon facing right."
  },
  weaponShotgun: {
    id: "weaponShotgun",
    key: "sprite.weapon.shotgun",
    path: "/assets/sprites/shotgun.png",
    examplePath: "/assets/sprites/shotgun.png",
    recommended: "Transparent PNG, weapon facing right."
  },
  camera: {
    id: "camera",
    key: "sprite.gadget.camera",
    path: "/assets/sprites/camera.png",
    examplePath: "/assets/sprites/camera.png",
    recommended: "Transparent PNG, 48x48, readable camera marker."
  },
  soundSensor: {
    id: "soundSensor",
    key: "sprite.gadget.sound-sensor",
    path: "/assets/sprites/sound-sensor.png",
    examplePath: "/assets/sprites/sound-sensor.png",
    recommended: "Transparent PNG, 48x48, readable sound sensor marker."
  },
  molotov: {
    id: "molotov",
    key: "sprite.fx.molotov",
    examplePath: "/assets/fx/molotov.png",
    recommended: "Transparent PNG, 64x64, fire patch or flame icon."
  },
  smoke: {
    id: "smoke",
    key: "sprite.fx.smoke",
    examplePath: "/assets/fx/smoke.png",
    recommended: "Transparent PNG, 64x64, soft smoke puff."
  },
  deployableWall: {
    id: "deployableWall",
    key: "sprite.gadget.deployable-wall",
    examplePath: "/assets/sprites/deployable-wall.png",
    recommended: "Transparent PNG, 64x24, tactical barricade facing right."
  },
  muzzleFlash: {
    id: "muzzleFlash",
    key: "sprite.fx.muzzle-flash",
    examplePath: "/assets/fx/muzzle-flash.png",
    recommended: "Transparent PNG, 48x24, brief flash facing right."
  },
  bulletImpact: {
    id: "bulletImpact",
    key: "sprite.fx.bullet-impact",
    examplePath: "/assets/fx/bullet-impact.png",
    recommended: "Transparent PNG, 32x32, spark or hit marker."
  }
};

export const imageAssetList = Object.values(imageAssets);

export const playerSpriteAssets = {
  worldSize: 40
} as const;

export const weaponSpriteAssets = {
  assault: {
    asset: imageAssets.weaponAssault,
    worldLength: 34,
    offsetX: 25
  },
  sniper: {
    asset: imageAssets.weaponSniper,
    worldLength: 60,
    offsetX: 35
  },
  shotgun: {
    asset: imageAssets.weaponShotgun,
    worldLength: 38,
    offsetX: 25
  }
} as const;

export const gadgetSpriteAssets = {
  camera: {
    asset: imageAssets.camera,
    worldSize: 25
  },
  soundSensor: {
    asset: imageAssets.soundSensor,
    worldSize: 20
  },
  molotov: {
    asset: imageAssets.molotov,
    worldSize: 42
  },
  smoke: {
    asset: imageAssets.smoke,
    worldSize: 56
  },
  deployableWall: {
    asset: imageAssets.deployableWall
  }
} as const;

export const fxSpriteAssets = {
  muzzleFlash: {
    asset: imageAssets.muzzleFlash,
    worldLength: 24
  },
  bulletImpact: {
    asset: imageAssets.bulletImpact,
    worldSize: 18
  }
} as const;
