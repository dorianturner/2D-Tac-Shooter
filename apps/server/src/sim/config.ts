export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const PLAYER_SPEED = 240 / TICK_RATE;
export const PLAYER_WALK_SPEED = 165 / TICK_RATE;
export const PLAYER_RADIUS = 10;
export const PLAYER_MAX_HP = 5;
export const PLAYER_CLOSE_VISION_RADIUS = 80;
export const VIEW_RANGE = 260;
export const VIEW_FOV = (100 * Math.PI) / 180;
export const FIRE_RANGE = 520;
export const FIRE_COOLDOWN_TICKS = Math.round(TICK_RATE / 10);
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

export const POST_GADGET_LOCKOUT_TICKS = Math.round(TICK_RATE * 0.4);

export const ROUND_COUNTDOWN_TICKS = 45;
export const ROUND_TICKS = 60 * TICK_RATE;
export const OVERTIME_TICKS = 30 * TICK_RATE;
export const OBJECTIVE_CAPTURE_TICKS = 8 * TICK_RATE;
export const DOOR_MAX_ANGLE = 1.92;
export const DOOR_DAMPING = 0.68;
export const DOOR_PUSH_STRENGTH = 0.034;
export const DOOR_RETURN_STRENGTH = 0;
export const DOOR_MAX_ANGULAR_SPEED = 0.06;
export const DOOR_MAX_ANGULAR_ACCELERATION = 0.018;
export const DOOR_COLLISION_SUBSTEPS = 6;
export const DOOR_PUSH_SKIN = 11;
export const DOOR_COLLISION_SKIN = 0.75;
export const DOOR_TOGGLE_RANGE = 64;
