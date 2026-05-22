import type { GadgetKind, PlayerClassDefinition, PlayerClassPresetId, PlayerLoadoutSelection, WeaponDefinition, WeaponPresetId } from "./types.js";

export const weaponPresets: Record<WeaponPresetId, WeaponDefinition> = {
  assault: {
    id: "assault",
    name: "Assault Rifle",
    damage: 1,
    effectiveRange: 520,
    fireCooldownTicks: 6,
    magSize: 10,
    visionRange: 260,
    visionFov: (100 * Math.PI) / 180,
    pelletCount: 1,
    spreadRadians: 0
  },
  sniper: {
    id: "sniper",
    name: "Sniper",
    damage: 5,
    effectiveRange: 820,
    fireCooldownTicks: 45,
    magSize: 5,
    visionRange: 420,
    visionFov: (44 * Math.PI) / 180,
    pelletCount: 1,
    spreadRadians: 0
  },
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
    damage: 5,
    effectiveRange: 190,
    fireCooldownTicks: 32,
    magSize: 6,
    visionRange: 260,
    visionFov: (100 * Math.PI) / 180,
    pelletCount: 7,
    spreadRadians: (10 * Math.PI) / 180
  }
};

export const defaultGadgetLoadout: Record<GadgetKind, number> = {
  camera: 1,
  molotov: 1,
  smoke: 2,
  wall: 2,
  sound: 1
};

export const playerClassPresets: Record<PlayerClassPresetId, PlayerClassDefinition> = {
  operator: {
    id: "operator",
    name: "Operator",
    gadgets: { ...defaultGadgetLoadout }
  },
  scout: {
    id: "scout",
    name: "Scout",
    gadgets: { camera: 2, molotov: 0, smoke: 2, wall: 1, sound: 2 }
  },
  breacher: {
    id: "breacher",
    name: "Breacher",
    gadgets: { camera: 0, molotov: 2, smoke: 1, wall: 3, sound: 1 }
  }
};

export function createPlayerClassFromPreset(id: PlayerClassPresetId): PlayerClassDefinition {
  const preset = playerClassPresets[id] ?? playerClassPresets.operator;
  return { ...preset, gadgets: { ...preset.gadgets } };
}

export function createPlayerClass(selection?: PlayerLoadoutSelection): PlayerClassDefinition {
  if (selection?.customClass) {
    return {
      id: "custom",
      name: selection.customClass.name || "Custom",
      gadgets: normalizeGadgets(selection.customClass.gadgets)
    };
  }
  return createPlayerClassFromPreset(selection?.classId ?? "operator");
}

export function createWeapon(selection?: PlayerLoadoutSelection): WeaponDefinition {
  const weapon = weaponPresets[selection?.weaponId ?? "assault"] ?? weaponPresets.assault;
  return { ...weapon };
}

function normalizeGadgets(gadgets: Partial<Record<GadgetKind, number>>): Record<GadgetKind, number> {
  return {
    camera: clampCount(gadgets.camera),
    molotov: clampCount(gadgets.molotov),
    smoke: clampCount(gadgets.smoke),
    wall: clampCount(gadgets.wall),
    sound: clampCount(gadgets.sound)
  };
}

function clampCount(value: number | undefined): number {
  return Math.max(0, Math.min(5, Math.floor(value ?? 0)));
}
