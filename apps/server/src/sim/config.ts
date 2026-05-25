export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_RATE_HZ = 60;
export const SNAPSHOT_INTERVAL_TICKS = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE_HZ));
export const MAX_SOCKET_BUFFERED_AMOUNT = 512 * 1024;
export const MAX_REPLAY_COMMANDS = 900;
export const MAX_REPLAY_EVENTS = 900;
export const MAX_ANALYTICS_EVENTS = 600;
export const ENABLE_MATCH_ANALYTICS = process.env.NODE_ENV !== "production";
export const MAX_EXPLORED_POINTS = 400;
export const MAX_ACTION_RESULTS = 32;
export const MAX_SOUND_EVENTS = 240;
export const SOUND_EVENT_TTL_TICKS = 3 * TICK_RATE;
export const NORMAL_VISION_RAYS = 54;
export const DEBUG_VISION_RAYS = 48;
export const PLAYER_WALK_SPEED = 160 / TICK_RATE;
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
export const OBJECTIVE_CAPTURE_TICKS = 5 * TICK_RATE;
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

export const SOUND_RADIUS_ASSAULT = 420;
export const SOUND_RADIUS_SHOTGUN = 360;
export const SOUND_RADIUS_SNIPER = 720;
export const SOUND_RADIUS_RELOAD = 120;
export const SOUND_RADIUS_RUN_FOOTSTEP = 135;
export const SOUND_RADIUS_WALK_FOOTSTEP = 45;
export const SOUND_RADIUS_GADGET = 180;
export const SOUND_RADIUS_ABILITY = 260;
export const SOUND_RADIUS_BREACH = 360;
export const SOUND_RADIUS_IMPACT = 150;
export const SOUND_RADIUS_DOOR = 115;
export const SOUND_RADIUS_ROUND = 900;
export const RUN_FOOTSTEP_INTERVAL_TICKS = 18;
export const WALK_FOOTSTEP_INTERVAL_TICKS = 36;
