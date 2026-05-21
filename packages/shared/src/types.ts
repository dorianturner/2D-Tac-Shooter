export type Team = "blue" | "orange";
export type PlayerId = "p1" | "p2";
export type RoundPhase = "lobby" | "countdown" | "active" | "ended";
export type SensorKind = "camera" | "motion";
export type UtilityKind = "emp" | "breach" | "fake-noise" | "smoke" | "flash" | "signal-spoof";
export type WallKind = "solid" | "transparent" | "door" | "mesh";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  kind?: WallKind;
  label?: string;
  roomId?: string;
  hinge?: Vec2;
  closedA?: Vec2;
  closedB?: Vec2;
  openAngle?: number;
  currentAngle?: number;
  angularVelocity?: number;
  a: Vec2;
  b: Vec2;
  thickness: number;
  blocksVision: boolean;
  blocksMovement: boolean;
  destructible: boolean;
  destroyed?: boolean;
}

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
  notes?: string;
}

export interface PlayerCommand {
  type: "command";
  seq: number;
  tick: number;
  move: Vec2;
  aim: number;
  fire: boolean;
  use: "none" | "breach";
}

export interface PlayerState {
  id: PlayerId;
  team: Team;
  position: Vec2;
  velocity: Vec2;
  aim: number;
  alive: boolean;
  hp: number;
}

export interface Detection {
  id: string;
  kind: SensorKind | "los" | "motion-pulse";
  position: Vec2;
  confidence: number;
  expiresAtTick: number;
  targetId?: PlayerId;
}

export interface ServerSnapshot {
  type: "snapshot";
  tick: number;
  playerId: PlayerId;
  round: RoundState;
  self: PlayerState;
  visiblePlayers: PlayerState[];
  detections: Detection[];
  map: {
    walls: Wall[];
    sensors: SensorDefinition[];
  };
  visiblePolygon: Vec2[];
  explored: Vec2[];
  debug?: DebugTruth;
}

export interface DebugTruth {
  players: PlayerState[];
  detections: Detection[];
  visibleByPlayer: Record<PlayerId, Vec2[]>;
}

export interface RoundState {
  phase: RoundPhase;
  startsAtTick: number;
  endsAtTick: number;
  winner?: PlayerId | "draw";
  reason?: "kill" | "timer";
}

export type AuthoritativeEvent =
  | { type: "round-start"; tick: number }
  | { type: "shot"; tick: number; shooter: PlayerId; origin: Vec2; aim: number }
  | { type: "hit"; tick: number; shooter: PlayerId; target: PlayerId }
  | { type: "kill"; tick: number; shooter: PlayerId; target: PlayerId }
  | { type: "sensor-detect"; tick: number; sensorId: string; target: PlayerId; confidence: number }
  | { type: "wall-destroyed"; tick: number; wallId: string; playerId: PlayerId }
  | { type: "round-end"; tick: number; winner: PlayerId | "draw"; reason: "kill" | "timer" };

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
  quickMatch?: boolean;
  reconnectToken?: string;
  debug?: boolean;
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
  phase: RoundPhase;
}

export type ClientMessage = ClientHello | PlayerCommand;
export type ServerMessage = ServerWelcome | ServerSnapshot | { type: "rooms"; rooms: RoomSummary[] } | { type: "error"; message: string };
