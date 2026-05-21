import type { GadgetKind } from "@tac/shared";

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const PLAYER_SPEED = 240 / TICK_RATE;
export const PLAYER_WALK_SPEED = 165 / TICK_RATE;
export const PLAYER_RADIUS = 10;
export const PLAYER_MAX_HP = 5;
export const VIEW_RANGE = 260;
export const VIEW_FOV = (100 * Math.PI) / 180;
export const FIRE_RANGE = 520;
export const FIRE_COOLDOWN_TICKS = 3;
export const MAG_SIZE = 10;
export const RELOAD_TICKS = TICK_RATE;

export const CAMERA_RANGE = 180;
export const CAMERA_RADIUS = 120;
export const CAMERA_HIT_RADIUS = 8;

export const MOLOTOV_RANGE = 220;
export const MOLOTOV_RADIUS = 55;
export const MOLOTOV_TICKS = 5 * TICK_RATE;
export const MOLOTOV_DAMAGE_INTERVAL = Math.floor(TICK_RATE / 2);

export const SMOKE_RANGE = 220;
export const SMOKE_RADIUS = 62;
export const SMOKE_TICKS = 5 * TICK_RATE;

export const DEPLOYABLE_WALL_RANGE = 180;
export const DEPLOYABLE_WALL_LENGTH = 36;
export const DEPLOYABLE_WALL_THICKNESS = 10;
export const DEPLOYABLE_WALL_HP = 8;

export const SOUND_SENSOR_RANGE = 180;
export const SOUND_SENSOR_RADIUS = 135;
export const SOUND_SENSOR_TRIGGER_TICKS = 18;
export const SOUND_SENSOR_SPEED_THRESHOLD = 0.55;
export const SOUND_SENSOR_HIT_RADIUS = 8;

export const POST_GADGET_LOCKOUT_TICKS = 12;

export const ROUND_COUNTDOWN_TICKS = 45;
export const ROUND_TICKS = 90 * TICK_RATE;
export const DOOR_MAX_ANGLE = 1.92;
export const DOOR_DAMPING = 0.86;

export const GADGET_LOADOUT: Record<GadgetKind, number> = {
  camera: 1,
  molotov: 1,
  smoke: 2,
  wall: 1,
  sound: 1
};
