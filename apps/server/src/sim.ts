import {
  add,
  angleBetween,
  angleToVector,
  distance,
  distanceToSegment,
  hasLineOfSight,
  mul,
  moveWithWallCollision,
  normalize,
  pointInCone,
  sampleMap,
  visiblePolygon,
  type AuthoritativeEvent,
  type ClientMessage,
  type Detection,
  type MapDefinition,
  type PlayerCommand,
  type PlayerId,
  type PlayerState,
  type ReplayLog,
  type RoundState,
  type ServerSnapshot,
  type ServerWelcome,
  type Vec2
} from "@tac/shared";

export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
const PLAYER_SPEED = 145 / TICK_RATE;
const PLAYER_RADIUS = 15;
const VIEW_RANGE = 390;
const FIRE_RANGE = 520;
const DOOR_MAX_ANGLE = 1.92;
const DOOR_DAMPING = 0.86;

interface AnalyticsEvent {
  type: string;
  tick: number;
  data: Record<string, unknown>;
}

interface PlayerSlot {
  id: PlayerId;
  connected: boolean;
  debug: boolean;
  reconnectToken: string;
  lastCommand: PlayerCommand;
  explored: Vec2[];
}

export interface RoomState {
  id: string;
  map: MapDefinition;
  tick: number;
  round: RoundState;
  players: Record<PlayerId, PlayerState>;
  slots: Record<PlayerId, PlayerSlot>;
  detections: Detection[];
  replay: ReplayLog;
  analytics: AnalyticsEvent[];
}

export function createRoom(id: string, sourceMap: MapDefinition = sampleMap): RoomState {
  const map = initializeRuntimeMap(structuredClone(sourceMap));
  const players = Object.fromEntries(
    map.spawns.map((spawn) => [
      spawn.id,
      {
        id: spawn.id,
        team: spawn.team,
        position: { ...spawn.position },
        velocity: { x: 0, y: 0 },
        aim: spawn.angle,
        alive: true,
        hp: 100
      }
    ])
  ) as Record<PlayerId, PlayerState>;

  return {
    id,
    map,
    tick: 0,
    round: { phase: "lobby", startsAtTick: 60, endsAtTick: 60 + 90 * TICK_RATE },
    players,
    slots: {
      p1: createSlot("p1"),
      p2: createSlot("p2")
    },
    detections: [],
    replay: { mapId: map.id, mapVersion: map.version, seed: 1, commands: [], events: [] },
    analytics: []
  };
}

function createSlot(id: PlayerId): PlayerSlot {
  return {
    id,
    connected: false,
    debug: false,
    reconnectToken: `${id}-${Math.random().toString(36).slice(2)}`,
    lastCommand: { type: "command", seq: 0, tick: 0, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none" },
    explored: []
  };
}

export function joinRoom(room: RoomState, debug = false, preferred?: PlayerId): ServerWelcome | null {
  const playerId = preferred ?? (!room.slots.p1.connected ? "p1" : !room.slots.p2.connected ? "p2" : null);
  if (!playerId) return null;
  const slot = room.slots[playerId];
  slot.connected = true;
  slot.debug = debug;
  if (room.slots.p1.connected && room.slots.p2.connected && room.round.phase === "lobby") {
    room.round.phase = "countdown";
  }
  return {
    type: "welcome",
    playerId,
    roomId: room.id,
    reconnectToken: slot.reconnectToken,
    map: room.map
  };
}

export function applyClientMessage(room: RoomState, playerId: PlayerId, message: ClientMessage): void {
  if (message.type !== "command") return;
  const command = {
    ...message,
    move: normalize(message.move),
    tick: room.tick
  };
  room.slots[playerId].lastCommand = command;
  room.replay.commands.push({ ...command, playerId });
}

export function stepRoom(room: RoomState): void {
  room.tick += 1;
  if (room.round.phase === "countdown" && room.tick >= room.round.startsAtTick) {
    room.round.phase = "active";
    pushEvent(room, { type: "round-start", tick: room.tick });
  }
  if (room.round.phase !== "active") return;

  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;
    const command = room.slots[player.id].lastCommand;
    const delta = { x: command.move.x * PLAYER_SPEED, y: command.move.y * PLAYER_SPEED };
    const desired = add(player.position, delta);
    pushDoors(room.map, player.position, desired, delta);
    integrateDoors(room.map);
    const next = moveWithWallCollision(room.map, player.position, desired, PLAYER_RADIUS);
    player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
    player.position = next;
    player.aim = command.aim;
    if (command.use === "breach") breachNearestWall(room, player.id);
    if (command.fire) resolveShot(room, player.id);
    room.analytics.push({ type: "movement-sample", tick: room.tick, data: { playerId: player.id, position: player.position } });
  }

  resolveSensors(room);
  room.detections = room.detections.filter((detection) => detection.expiresAtTick >= room.tick);

  if (room.tick >= room.round.endsAtTick) {
    endRound(room, "draw", "timer");
  }
}

export function initializeRuntimeMap(map: MapDefinition): MapDefinition {
  return {
    ...map,
    walls: map.walls.map((wall) => {
      if (wall.kind !== "door") return wall;
      const hinge = wall.hinge ?? wall.closedA ?? wall.a;
      const closedB = wall.closedB ?? wall.b;
      return {
        ...wall,
        hinge,
        closedA: wall.closedA ?? wall.a,
        closedB,
        currentAngle: wall.currentAngle ?? 0,
        angularVelocity: wall.angularVelocity ?? 0,
        blocksMovement: true,
        blocksVision: false,
        destructible: wall.destructible,
        a: hinge,
        b: rotateDoorEndpoint(hinge, closedB, wall.currentAngle ?? 0)
      };
    })
  };
}

function pushDoors(map: MapDefinition, from: Vec2, desired: Vec2, delta: Vec2): void {
  if (Math.hypot(delta.x, delta.y) < 0.01) return;
  for (const door of map.walls) {
    if (door.kind !== "door" || !door.hinge) continue;
    if (distanceToSegment(desired, door.a, door.b) > PLAYER_RADIUS + Math.max(10, door.thickness)) continue;
    const radius = { x: desired.x - door.hinge.x, y: desired.y - door.hinge.y };
    const torque = radius.x * delta.y - radius.y * delta.x;
    door.angularVelocity = (door.angularVelocity ?? 0) + Math.max(-0.08, Math.min(0.08, torque * 0.0009));
  }
}

function integrateDoors(map: MapDefinition): void {
  for (const door of map.walls) {
    if (door.kind !== "door" || !door.hinge || !door.closedB) continue;
    const angle = Math.max(-DOOR_MAX_ANGLE, Math.min(DOOR_MAX_ANGLE, (door.currentAngle ?? 0) + (door.angularVelocity ?? 0)));
    door.currentAngle = angle;
    door.angularVelocity = (door.angularVelocity ?? 0) * DOOR_DAMPING;
    if (Math.abs(door.angularVelocity) < 0.0005) door.angularVelocity = 0;
    door.a = door.hinge;
    door.b = rotateDoorEndpoint(door.hinge, door.closedB, angle);
  }
}

function rotateDoorEndpoint(hinge: Vec2, closedB: Vec2, angle: number): Vec2 {
  const length = distance(hinge, closedB);
  const base = Math.atan2(closedB.y - hinge.y, closedB.x - hinge.x);
  return add(hinge, mul(angleToVector(base + angle), length));
}

function resolveShot(room: RoomState, shooterId: PlayerId): void {
  const shooter = room.players[shooterId];
  const targetId: PlayerId = shooterId === "p1" ? "p2" : "p1";
  const target = room.players[targetId];
  if (!shooter.alive || !target.alive) return;

  pushEvent(room, { type: "shot", tick: room.tick, shooter: shooterId, origin: shooter.position, aim: shooter.aim });
  const targetAngle = angleBetween(shooter.position, target.position);
  const aimError = Math.abs((((targetAngle - shooter.aim + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
  if (distance(shooter.position, target.position) <= FIRE_RANGE && aimError < 0.12 && hasLineOfSight(room.map, shooter.position, target.position)) {
    target.hp = 0;
    target.alive = false;
    pushEvent(room, { type: "hit", tick: room.tick, shooter: shooterId, target: targetId });
    pushEvent(room, { type: "kill", tick: room.tick, shooter: shooterId, target: targetId });
    endRound(room, shooterId, "kill");
  }
}

function breachNearestWall(room: RoomState, playerId: PlayerId): void {
  const player = room.players[playerId];
  const wall = room.map.walls.find((candidate) => candidate.destructible && !candidate.destroyed && distance(player.position, midpoint(candidate.a, candidate.b)) < 90);
  if (!wall) return;
  wall.destroyed = true;
  pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: wall.id, playerId });
  room.analytics.push({ type: "route-opened", tick: room.tick, data: { wallId: wall.id, playerId } });
}

function resolveSensors(room: RoomState): void {
  for (const sensor of room.map.sensors) {
    if (sensor.destroyed || sensor.corrupted) continue;
    const target = room.players[sensor.owner === "p1" ? "p2" : "p1"];
    if (!target.alive) continue;
    const seesTarget = sensor.kind === "camera"
      ? pointInCone(sensor.position, sensor.angle, sensor.fov, sensor.range, target.position) && hasLineOfSight(room.map, sensor.position, target.position)
      : distance(sensor.position, target.position) <= sensor.range && hasLineOfSight(room.map, sensor.position, target.position) && room.tick % 20 === 0;
    if (!seesTarget) continue;
    const confidence = sensor.kind === "camera" ? 0.82 : 0.55;
    const noise = sensor.kind === "motion" ? Math.sin(room.tick * 12.9898) * 18 : 0;
    const detection: Detection = {
      id: `${sensor.id}-${room.tick}`,
      kind: sensor.kind === "motion" ? "motion-pulse" : "camera",
      position: { x: target.position.x + noise, y: target.position.y - noise },
      confidence,
      expiresAtTick: room.tick + (sensor.kind === "motion" ? 35 : 8),
      targetId: target.id
    };
    room.detections.push(detection);
    pushEvent(room, { type: "sensor-detect", tick: room.tick, sensorId: sensor.id, target: target.id, confidence });
    room.analytics.push({ type: "sensor-detection", tick: room.tick, data: { sensorId: sensor.id, targetId: target.id, confidence } });
  }
}

export function snapshotFor(room: RoomState, playerId: PlayerId): ServerSnapshot {
  const self = room.players[playerId];
  const opponentId: PlayerId = playerId === "p1" ? "p2" : "p1";
  const opponent = room.players[opponentId];
  const visiblePlayers: PlayerState[] = [];
  if (opponent.alive && hasLineOfSight(room.map, self.position, opponent.position) && distance(self.position, opponent.position) <= VIEW_RANGE) {
    visiblePlayers.push({ ...opponent, position: { ...opponent.position }, velocity: { ...opponent.velocity } });
  }
  const detections = room.detections.filter((detection) => detection.targetId === opponentId || room.map.sensors.find((sensor) => sensor.id === detection.id.split("-")[0] && sensor.owner === playerId));
  const polygon = visiblePolygon(room.map, self.position, VIEW_RANGE, 80);
  room.slots[playerId].explored.push(...polygon.filter((_, index) => index % 8 === 0));
  room.slots[playerId].explored = room.slots[playerId].explored.slice(-400);

  const snapshot: ServerSnapshot = {
    type: "snapshot",
    tick: room.tick,
    playerId,
    round: { ...room.round },
    self: { ...self, position: { ...self.position }, velocity: { ...self.velocity } },
    visiblePlayers,
    detections,
    map: {
      walls: room.map.walls,
      sensors: room.map.sensors.filter((sensor) => sensor.owner === playerId || hasLineOfSight(room.map, self.position, sensor.position))
    },
    visiblePolygon: polygon,
    explored: room.slots[playerId].explored
  };

  if (room.slots[playerId].debug) {
    snapshot.debug = {
      players: Object.values(room.players),
      detections: room.detections,
      visibleByPlayer: {
        p1: visiblePolygon(room.map, room.players.p1.position, VIEW_RANGE, 48),
        p2: visiblePolygon(room.map, room.players.p2.position, VIEW_RANGE, 48)
      }
    };
  }
  return snapshot;
}

function endRound(room: RoomState, winner: PlayerId | "draw", reason: "kill" | "timer"): void {
  if (room.round.phase === "ended") return;
  room.round.phase = "ended";
  room.round.winner = winner;
  room.round.reason = reason;
  pushEvent(room, { type: "round-end", tick: room.tick, winner, reason });
}

function pushEvent(room: RoomState, event: AuthoritativeEvent): void {
  room.replay.events.push(event);
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
