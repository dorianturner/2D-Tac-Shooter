export type Team = "blue" | "orange";
export type PlayerId = `p${number}`;
export type RoundPhase = "lobby" | "countdown" | "active" | "overtime" | "ended";
export type SensorKind = "camera" | "motion" | "sound";
export type UtilityKind = "emp" | "breach" | "fake-noise" | "smoke" | "flash" | "signal-spoof";
export type SegmentPresetId = "wall" | "window" | "mesh" | "breakable-wall" | "door" | "deployable-wall";
export type WallKind = "solid" | "transparent" | "door" | "mesh";
export type GadgetKind = "camera" | "molotov" | "smoke" | "wall" | "sound";
export type WeaponPresetId = "assault" | "sniper" | "shotgun";
export type PlayerClassPresetId = "operator" | "scout" | "breacher";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Segment {
  id: string;
  preset?: SegmentPresetId;
  /** @deprecated use preset plus explicit segment properties. */
  kind?: WallKind;
  label?: string;
  roomId?: string;
  hinge?: Vec2;
  closedA?: Vec2;
  closedB?: Vec2;
  openAngle?: number;
  restAngle?: number;
  targetAngle?: number;
  currentAngle?: number;
  angularVelocity?: number;
  lastPushTick?: number;
  pushContactTicks?: number;
  lastPushSign?: number;
  blockedUntilTick?: number;
  a: Vec2;
  b: Vec2;
  thickness: number;
  blocksVision: boolean;
  blocksMovement: boolean;
  blocksShooting: boolean;
  destructible: boolean;
  hp?: number;
  maxHp?: number;
  destroyed?: boolean;
}

export type Wall = Segment;

export interface Spawn {
  id: PlayerId;
  team: Team;
  position: Vec2;
  angle: number;
}

export interface SensorDefinition {
  id: string;
  owner: PlayerId;
  kind: SensorKind;
  position: Vec2;
  angle: number;
  range: number;
  fov: number;
  corrupted?: boolean;
  destroyed?: boolean;
}

export interface RoomDefinition {
  id: string;
  name: string;
  position: Vec2;
  size: Vec2;
}

export interface UtilityPlacement {
  id: string;
  kind: UtilityKind;
  position: Vec2;
  radius: number;
  owner?: PlayerId;
}

export interface LightNode {
  id: string;
  position: Vec2;
  radius: number;
  intensity: number;
  destructible: boolean;
  destroyed?: boolean;
}

export interface ObjectiveDefinition {
  id: string;
  position: Vec2;
  radius: number;
}

export interface MapDefinition {
  id: string;
  version: number;
  name: string;
  bounds: { width: number; height: number };
  gridSize?: number;
  rooms?: RoomDefinition[];
  walls: Wall[];
  spawns: Spawn[];
  sensors: SensorDefinition[];
  utilityPlacements?: UtilityPlacement[];
  lighting?: LightNode[];
  objective?: ObjectiveDefinition;
  notes?: string;
}

export interface PlayerCommand {
  type: "command";
  seq: number;
  tick: number;
  move: Vec2;
  aim: number;
  fire: boolean;
  use: "none" | "breach" | "door-toggle";
  reload?: boolean;
  gadget?: "none" | GadgetKind;
  gadgetTarget?: Vec2;
  gadgetAngle?: number;
  walk?: boolean;
}

export interface WeaponDefinition {
  id: WeaponPresetId;
  name: string;
  damage: number;
  effectiveRange: number;
  fireCooldownTicks: number;
  magSize: number;
  visionRange: number;
  visionFov: number;
  pelletCount: number;
  spreadRadians: number;
}

export interface PlayerClassDefinition {
  id: PlayerClassPresetId | "custom";
  name: string;
  gadgets: Record<GadgetKind, number>;
}

export interface PlayerLoadoutSelection {
  classId?: PlayerClassPresetId;
  weaponId?: WeaponPresetId;
  customClass?: {
    name: string;
    gadgets: Partial<Record<GadgetKind, number>>;
  };
}

export interface PlayerState {
  id: PlayerId;
  team: Team;
  classId: PlayerClassDefinition["id"];
  className: string;
  weaponId: WeaponPresetId;
  weaponName: string;
  gadgetLoadout: Record<GadgetKind, number>;
  position: Vec2;
  velocity: Vec2;
  aim: number;
  alive: boolean;
  hp: number;
  ammo: number;
  magSize: number;
  isReloading: boolean;
  reloadEndsAtTick?: number;
  gadgets: Record<GadgetKind, number>;
  walking?: boolean;
}

export interface Detection {
  id: string;
  kind: SensorKind | "los" | "motion-pulse" | "sound-area";
  position: Vec2;
  radius?: number;
  confidence: number;
  expiresAtTick: number;
  owner?: PlayerId;
  targetId?: PlayerId;
}

export interface ActionResult {
  seq: number;
  action: "reload" | "gadget" | "use";
  accepted: boolean;
  reason?: "out-of-range" | "blocked-los" | "no-count" | "action-lockout" | "round-inactive" | "invalid";
}

export interface ServerSnapshot {
  type: "snapshot";
  tick: number;
  playerId: PlayerId;
  round: RoundState;
  self: PlayerState;
  nextLoadout?: PlayerLoadoutSelection;
  visiblePlayers: PlayerState[];
  detections: Detection[];
  map: {
    walls: Wall[];
    sensors: SensorDefinition[];
  };
  gadgets: {
    cameras: DeployedCamera[];
    molotovs: MolotovZone[];
    smokes: SmokeZone[];
    soundSensors: SoundSensorZone[];
  };
  shotImpacts: ShotImpact[];
  visiblePolygon: Vec2[];
  visibleCircles: VisionCircle[];
  explored: Vec2[];
  actionResults: ActionResult[];
  debug?: DebugTruth;
}

export interface VisionCircle {
  position: Vec2;
  radius: number;
}

export interface DebugTruth {
  players: PlayerState[];
  detections: Detection[];
  visibleByPlayer: Record<PlayerId, Vec2[]>;
}

export interface RoundState {
  phase: RoundPhase;
  roundNumber: number;
  scores: Record<PlayerId, number>;
  startsAtTick: number;
  endsAtTick: number;
  overtimeEndsAtTick?: number;
  nextRoundStartsAtTick?: number;
  objective?: {
    position: Vec2;
    radius: number;
    owner?: PlayerId;
    progressTicks: number;
    requiredTicks: number;
  };
  winner?: PlayerId | "draw";
  matchWinner?: PlayerId;
  reason?: "kill" | "timer" | "objective";
}

export interface ShotImpact {
  id: string;
  tick: number;
  shooter: PlayerId;
  origin: Vec2;
  end: Vec2;
  hit: "none" | "player" | "wall" | "camera" | "sound-sensor";
  targetId?: PlayerId;
  wallId?: string;
  cameraId?: string;
  soundSensorId?: string;
}

export interface DeployedCamera {
  id: string;
  owner: PlayerId;
  position: Vec2;
  radius: number;
  hp: number;
  destroyed?: boolean;
}

export interface MolotovZone {
  id: string;
  owner: PlayerId;
  position: Vec2;
  radius: number;
  createdAtTick: number;
  expiresAtTick: number;
}

export interface SmokeZone {
  id: string;
  owner: PlayerId;
  position: Vec2;
  radius: number;
  createdAtTick: number;
  expiresAtTick: number;
}

export interface SoundSensorZone {
  id: string;
  owner: PlayerId;
  position: Vec2;
  radius: number;
  hp: number;
  createdAtTick: number;
  expiresAtTick?: number;
  triggeredUntilTick?: number;
  destroyed?: boolean;
}

export type AuthoritativeEvent =
  | { type: "round-start"; tick: number }
  | { type: "shot"; tick: number; impact: ShotImpact }
  | { type: "hit"; tick: number; shooter: PlayerId; target: PlayerId }
  | { type: "kill"; tick: number; shooter: PlayerId; target: PlayerId }
  | { type: "sensor-detect"; tick: number; sensorId: string; target: PlayerId; confidence: number }
  | { type: "wall-destroyed"; tick: number; wallId: string; playerId: PlayerId }
  | { type: "camera-deployed"; tick: number; playerId: PlayerId; cameraId: string }
  | { type: "camera-destroyed"; tick: number; playerId: PlayerId; cameraId: string }
  | { type: "molotov-deployed"; tick: number; playerId: PlayerId; molotovId: string }
  | { type: "smoke-deployed"; tick: number; playerId: PlayerId; smokeId: string }
  | { type: "deployable-wall-deployed"; tick: number; playerId: PlayerId; wallId: string }
  | { type: "sound-sensor-deployed"; tick: number; playerId: PlayerId; sensorId: string }
  | { type: "round-end"; tick: number; winner: PlayerId | "draw"; reason: "kill" | "timer" | "objective" };

export interface ReplayLog {
  mapId: string;
  mapVersion: number;
  seed: number;
  commands: Array<PlayerCommand & { playerId: PlayerId }>;
  events: AuthoritativeEvent[];
}

export interface ClientHello {
  type: "hello";
  mode?: "create" | "join";
  mapId?: string;
  roomId?: string;
  loadout?: PlayerLoadoutSelection;
  quickMatch?: boolean;
  reconnectToken?: string;
  debug?: boolean;
}

export interface RematchRequest {
  type: "rematch";
}

export interface LoadoutChangeRequest {
  type: "loadout";
  loadout: PlayerLoadoutSelection;
}

export interface ServerWelcome {
  type: "welcome";
  playerId: PlayerId;
  roomId: string;
  reconnectToken: string;
  map: MapDefinition;
}

export interface RoomSummary {
  id: string;
  mapId: string;
  mapName: string;
  playerCount: number;
  maxPlayers: number;
  phase: RoundPhase;
}

export type ClientMessage = ClientHello | PlayerCommand | RematchRequest | LoadoutChangeRequest;
export type ServerMessage = ServerWelcome | ServerSnapshot | { type: "rooms"; rooms: RoomSummary[] } | { type: "error"; message: string };
