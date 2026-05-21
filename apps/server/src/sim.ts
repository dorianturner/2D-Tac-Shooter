import {
  add,
  angleToVector,
  distance,
  distanceToSegment,
  hasLineOfSight,
  lineIntersection,
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
  type ServerSnapshot,
  type ServerWelcome,
  type ShotImpact,
  type Vec2
} from "@tac/shared";

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
const PLAYER_SPEED = 165 / TICK_RATE;
const PLAYER_RADIUS = 10;
const PLAYER_MAX_HP = 5;
const VIEW_RANGE = 390;
const FIRE_RANGE = 520;
const FIRE_COOLDOWN_TICKS = 3;
const ROUND_COUNTDOWN_TICKS = 45;
const ROUND_TICKS = 90 * TICK_RATE;
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
  nextFireTick: number;
}

export interface RoomState {
  id: string;
  map: MapDefinition;
  baseMap: MapDefinition;
  tick: number;
  round: ServerSnapshot["round"];
  players: Record<PlayerId, PlayerState>;
  slots: Record<PlayerId, PlayerSlot>;
  detections: Detection[];
  shotImpacts: ShotImpact[];
  rematchRequests: Set<PlayerId>;
  replay: ReplayLog;
  analytics: AnalyticsEvent[];
}

export function createRoom(id: string, sourceMap: MapDefinition = sampleMap): RoomState {
  const baseMap = structuredClone(sourceMap);
  const map = initializeRuntimeMap(structuredClone(baseMap));
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
        hp: PLAYER_MAX_HP
      }
    ])
  ) as Record<PlayerId, PlayerState>;

  return {
    id,
    map,
    baseMap,
    tick: 0,
    round: { phase: "lobby", roundNumber: 1, scores: { p1: 0, p2: 0 }, startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS },
    players,
    slots: { p1: createSlot("p1"), p2: createSlot("p2") },
    detections: [],
    shotImpacts: [],
    rematchRequests: new Set(),
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
    explored: [],
    nextFireTick: 0
  };
}

export function joinRoom(room: RoomState, debug = false, preferred?: PlayerId): ServerWelcome | null {
  const playerId = preferred ?? (!room.slots.p1.connected ? "p1" : !room.slots.p2.connected ? "p2" : null);
  if (!playerId || room.round.matchWinner) return null;
  const slot = room.slots[playerId];
  slot.connected = true;
  slot.debug = debug;
  if (room.slots.p1.connected && room.slots.p2.connected && room.round.phase === "lobby") {
    room.round.phase = "countdown";
  }
  return { type: "welcome", playerId, roomId: room.id, reconnectToken: slot.reconnectToken, map: room.map };
}

export function applyClientMessage(room: RoomState, playerId: PlayerId, message: ClientMessage): void {
  if (message.type === "rematch") {
    room.rematchRequests.add(playerId);
    if (room.round.matchWinner && room.rematchRequests.has("p1") && room.rematchRequests.has("p2")) resetMatch(room);
    return;
  }
  if (message.type !== "command") return;
  const command = { ...message, move: normalize(message.move), tick: room.tick };
  room.slots[playerId].lastCommand = command;
  room.replay.commands.push({ ...command, playerId });
}

export function stepRoom(room: RoomState): void {
  room.tick += 1;
  room.shotImpacts = room.shotImpacts.filter((impact) => impact.tick >= room.tick - 5);
  integrateDoors(room.map);
  if (room.round.phase === "ended") return;
  if (room.round.phase === "countdown" && room.tick >= room.round.startsAtTick) {
    room.round.phase = "active";
    delete room.round.winner;
    delete room.round.reason;
    delete room.round.nextRoundStartsAtTick;
    pushEvent(room, { type: "round-start", tick: room.tick });
  }
  if (room.round.phase !== "active") return;

  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;
    const command = room.slots[player.id].lastCommand;
    const delta = { x: command.move.x * PLAYER_SPEED, y: command.move.y * PLAYER_SPEED };
    const desired = add(player.position, delta);
    pushDoors(room.map, desired, delta);
    const next = moveWithWallCollision(room.map, player.position, desired, PLAYER_RADIUS);
    player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
    player.position = next;
    player.aim = command.aim;
    if (command.use === "breach") breachNearestWall(room, player);
    if (command.fire) resolveShot(room, player.id);
    room.analytics.push({ type: "movement-sample", tick: room.tick, data: { playerId: player.id, position: player.position } });
  }

  resolveSensors(room);
  room.detections = room.detections.filter((detection) => detection.expiresAtTick >= room.tick);
  if (room.tick >= room.round.endsAtTick) finishRound(room, "draw", "timer");
}

export function initializeRuntimeMap(map: MapDefinition): MapDefinition {
  return {
    ...map,
    walls: map.walls.map((wall) => {
      const withHp = initializeWallHp(wall);
      if (withHp.kind !== "door") return withHp;
      const hinge = withHp.hinge ?? withHp.closedA ?? withHp.a;
      const closedB = withHp.closedB ?? withHp.b;
      return {
        ...withHp,
        hinge,
        closedA: withHp.closedA ?? withHp.a,
        closedB,
        currentAngle: withHp.currentAngle ?? 0,
        angularVelocity: withHp.angularVelocity ?? 0,
        blocksMovement: true,
        blocksVision: false,
        a: hinge,
        b: rotateDoorEndpoint(hinge, closedB, withHp.currentAngle ?? 0)
      };
    })
  };
}

function initializeWallHp(wall: MapDefinition["walls"][number]): MapDefinition["walls"][number] {
  if (!wall.destructible || wall.kind === "door") {
    const { hp: _hp, maxHp: _maxHp, ...runtimeWall } = wall;
    return runtimeWall;
  }
  const maxHp = wall.kind === "mesh" || wall.kind === "transparent" ? 1 : 5;
  return { ...wall, maxHp, hp: wall.hp ?? maxHp };
}

function pushDoors(map: MapDefinition, desired: Vec2, delta: Vec2): void {
  if (Math.hypot(delta.x, delta.y) < 0.01) return;
  for (const door of map.walls) {
    if (door.kind !== "door" || !door.hinge || door.destroyed) continue;
    if (distanceToSegment(desired, door.a, door.b) > PLAYER_RADIUS + Math.max(10, door.thickness)) continue;
    const radius = { x: desired.x - door.hinge.x, y: desired.y - door.hinge.y };
    const torque = radius.x * delta.y - radius.y * delta.x;
    door.angularVelocity = (door.angularVelocity ?? 0) + Math.max(-0.08, Math.min(0.08, torque * 0.0009));
  }
}

function integrateDoors(map: MapDefinition): void {
  for (const door of map.walls) {
    if (door.kind !== "door" || !door.hinge || !door.closedB || door.destroyed) continue;
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
  const slot = room.slots[shooterId];
  if (room.tick < slot.nextFireTick) return;
  slot.nextFireTick = room.tick + FIRE_COOLDOWN_TICKS;
  const shooter = room.players[shooterId];
  if (!shooter.alive) return;
  const origin = { ...shooter.position };
  const rayEnd = add(origin, mul(angleToVector(shooter.aim), FIRE_RANGE));
  const hit = resolveHitscan(room, shooterId, origin, rayEnd);
  const impact: ShotImpact = { id: `${shooterId}-${room.tick}-${room.shotImpacts.length}`, tick: room.tick, shooter: shooterId, origin, end: hit.end, hit: hit.kind, ...(hit.targetId ? { targetId: hit.targetId } : {}), ...(hit.wallId ? { wallId: hit.wallId } : {}) };
  room.shotImpacts.push(impact);
  pushEvent(room, { type: "shot", tick: room.tick, impact });

  if (hit.kind === "player" && hit.targetId) {
    const target = room.players[hit.targetId];
    target.hp = Math.max(0, target.hp - 1);
    pushEvent(room, { type: "hit", tick: room.tick, shooter: shooterId, target: hit.targetId });
    if (target.hp <= 0) {
      target.alive = false;
      pushEvent(room, { type: "kill", tick: room.tick, shooter: shooterId, target: hit.targetId });
      finishRound(room, shooterId, "kill");
    }
  } else if (hit.kind === "wall" && hit.wallId) {
    damageWall(room, hit.wallId, shooterId);
  }
}

function resolveHitscan(room: RoomState, shooterId: PlayerId, origin: Vec2, rayEnd: Vec2): { kind: "none" | "player" | "wall"; end: Vec2; targetId?: PlayerId; wallId?: string } {
  const direction = normalize({ x: rayEnd.x - origin.x, y: rayEnd.y - origin.y });
  let nearest: { kind: "none" | "player" | "wall"; distance: number; end: Vec2; targetId?: PlayerId; wallId?: string } = { kind: "none", distance: FIRE_RANGE, end: rayEnd };
  const targetId: PlayerId = shooterId === "p1" ? "p2" : "p1";
  const target = room.players[targetId];
  const playerDistance = target.alive ? rayCircleDistance(origin, direction, target.position, PLAYER_RADIUS) : null;
  if (playerDistance !== null) nearest = { kind: "player", distance: playerDistance, end: add(origin, mul(direction, playerDistance)), targetId };

  for (const wall of room.map.walls) {
    if (wall.destroyed) continue;
    const hit = lineIntersection(origin, rayEnd, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (wall.destructible && wall.kind !== "door" && (wall.kind === "transparent" || wall.kind === "mesh")) {
      damageWall(room, wall.id, shooterId);
      continue;
    }
    const blocksShot = wall.kind === "door" || wall.blocksVision || wall.kind === "solid";
    if (blocksShot && hitDistance < nearest.distance) nearest = { kind: "wall", distance: hitDistance, end: hit, wallId: wall.id };
  }
  return nearest;
}

function rayCircleDistance(origin: Vec2, direction: Vec2, center: Vec2, radius: number): number | null {
  const toCenter = { x: center.x - origin.x, y: center.y - origin.y };
  const projection = toCenter.x * direction.x + toCenter.y * direction.y;
  if (projection < 0 || projection > FIRE_RANGE) return null;
  return distance(add(origin, mul(direction, projection)), center) <= radius ? projection : null;
}

function damageWall(room: RoomState, wallId: string, shooterId: PlayerId): void {
  const wall = room.map.walls.find((candidate) => candidate.id === wallId);
  if (!wall?.destructible || wall.kind === "door" || wall.destroyed) return;
  wall.hp = Math.max(0, (wall.hp ?? wall.maxHp ?? 1) - 1);
  if (wall.hp <= 0) {
    wall.destroyed = true;
    pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: wall.id, playerId: shooterId });
  }
}

function finishRound(room: RoomState, winner: PlayerId | "draw", reason: "kill" | "timer"): void {
  if (winner !== "draw") room.round.scores[winner] += 1;
  room.round.winner = winner;
  room.round.reason = reason;
  pushEvent(room, { type: "round-end", tick: room.tick, winner, reason });
  if (winner !== "draw" && room.round.scores[winner] >= 2) {
    room.round.phase = "ended";
    room.round.matchWinner = winner;
    return;
  }
  room.round.phase = "countdown";
  room.round.roundNumber += 1;
  room.round.nextRoundStartsAtTick = room.tick + ROUND_COUNTDOWN_TICKS;
  room.round.startsAtTick = room.round.nextRoundStartsAtTick;
  room.round.endsAtTick = room.round.startsAtTick + ROUND_TICKS;
  resetPlayersForRound(room);
}

function resetPlayersForRound(room: RoomState): void {
  for (const spawn of room.map.spawns) {
    const player = room.players[spawn.id];
    player.position = { ...spawn.position };
    player.velocity = { x: 0, y: 0 };
    player.aim = spawn.angle;
    player.alive = true;
    player.hp = PLAYER_MAX_HP;
    room.slots[player.id].lastCommand = { type: "command", seq: 0, tick: room.tick, move: { x: 0, y: 0 }, aim: spawn.angle, fire: false, use: "none" };
    room.slots[player.id].nextFireTick = room.tick;
  }
}

function resetMatch(room: RoomState): void {
  room.tick = 0;
  room.map = initializeRuntimeMap(structuredClone(room.baseMap));
  room.round = { phase: "countdown", roundNumber: 1, scores: { p1: 0, p2: 0 }, startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS };
  room.rematchRequests.clear();
  room.shotImpacts = [];
  resetPlayersForRound(room);
}

function breachNearestWall(room: RoomState, player: PlayerState): void {
  const target = room.map.walls
    .filter((wall) => wall.destructible && wall.kind !== "door" && !wall.destroyed)
    .map((wall) => ({ wall, distance: distanceToSegment(player.position, wall.a, wall.b) }))
    .filter(({ distance: wallDistance }) => wallDistance <= 52)
    .sort((a, b) => a.distance - b.distance)[0]?.wall;
  if (!target) return;
  target.destroyed = true;
  pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: target.id, playerId: player.id });
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
    const detection: Detection = { id: `${sensor.id}-${room.tick}`, kind: sensor.kind === "motion" ? "motion-pulse" : "camera", position: { x: target.position.x + noise, y: target.position.y - noise }, confidence, expiresAtTick: room.tick + (sensor.kind === "motion" ? 35 : 8), targetId: target.id };
    room.detections.push(detection);
    pushEvent(room, { type: "sensor-detect", tick: room.tick, sensorId: sensor.id, target: target.id, confidence });
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
  const polygon = visiblePolygon(room.map, self.position, VIEW_RANGE, 80);
  room.slots[playerId].explored.push(...polygon.filter((_, index) => index % 8 === 0));
  room.slots[playerId].explored = room.slots[playerId].explored.slice(-400);

  const snapshot: ServerSnapshot = {
    type: "snapshot",
    tick: room.tick,
    playerId,
    round: { ...room.round, scores: { ...room.round.scores } },
    self: { ...self, position: { ...self.position }, velocity: { ...self.velocity } },
    visiblePlayers,
    detections: room.detections,
    map: { walls: room.map.walls, sensors: room.map.sensors },
    shotImpacts: room.shotImpacts,
    visiblePolygon: polygon,
    explored: room.slots[playerId].explored
  };

  if (room.slots[playerId].debug) {
    snapshot.debug = { players: Object.values(room.players), detections: room.detections, visibleByPlayer: { p1: visiblePolygon(room.map, room.players.p1.position, VIEW_RANGE, 48), p2: visiblePolygon(room.map, room.players.p2.position, VIEW_RANGE, 48) } };
  }
  return snapshot;
}

function pushEvent(room: RoomState, event: AuthoritativeEvent): void {
  room.replay.events.push(event);
}
