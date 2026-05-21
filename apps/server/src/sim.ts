import {
  add,
  angleToVector,
  distance,
  distanceToSegment,
  hasLineOfSight,
  lineIntersection,
  mul,
  normalize,
  pointInCone,
  sampleMap,
  type AuthoritativeEvent,
  type ActionResult,
  type ClientMessage,
  type DeployedCamera,
  type Detection,
  type GadgetKind,
  type MapDefinition,
  type MolotovZone,
  type PlayerCommand,
  type PlayerId,
  type PlayerState,
  type ReplayLog,
  type ServerSnapshot,
  type ServerWelcome,
  type ShotImpact,
  type SmokeZone,
  type SoundSensorZone,
  type Vec2,
  type Wall
} from "@tac/shared";
import {
  CAMERA_HIT_RADIUS,
  CAMERA_RANGE,
  CAMERA_RADIUS,
  DOOR_COLLISION_SUBSTEPS,
  DOOR_COLLISION_SKIN,
  DEPLOYABLE_WALL_RANGE,
  DOOR_DAMPING,
  DOOR_MAX_ANGLE,
  DOOR_MAX_ANGULAR_ACCELERATION,
  DOOR_MAX_ANGULAR_SPEED,
  DOOR_PUSH_SKIN,
  DOOR_PUSH_STRENGTH,
  DOOR_RETURN_STRENGTH,
  FIRE_COOLDOWN_TICKS,
  FIRE_RANGE,
  GADGET_LOADOUT,
  MAG_SIZE,
  MOLOTOV_DAMAGE_INTERVAL,
  MOLOTOV_RANGE,
  MOLOTOV_RADIUS,
  MOLOTOV_TICKS,
  PLAYER_WALK_SPEED,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POST_GADGET_LOCKOUT_TICKS,
  RELOAD_TICKS,
  ROUND_COUNTDOWN_TICKS,
  ROUND_TICKS,
  SMOKE_RANGE,
  SMOKE_RADIUS,
  SMOKE_TICKS,
  SOUND_SENSOR_HIT_RADIUS,
  SOUND_SENSOR_RANGE,
  SOUND_SENSOR_RADIUS,
  SOUND_SENSOR_SPEED_THRESHOLD,
  SOUND_SENSOR_TRIGGER_TICKS,
  VIEW_FOV,
  VIEW_RANGE
} from "./sim/config.js";
import { clampTarget, createDeployableWall, hasPlacementLineOfSight, isPlacementClear, resolveThrownTarget } from "./sim/deployables.js";
import { hasConeLineOfSightWithSmoke, hasLineOfSightWithSmoke, visibleConePolygonWithSmoke } from "./sim/visibility.js";

export { TICK_MS, TICK_RATE } from "./sim/config.js";

interface AnalyticsEvent {
  type: string;
  tick: number;
  data: Record<string, unknown>;
}

type InputState = Pick<PlayerCommand, "move" | "aim" | "fire" | "walk">;

type PendingAction =
  | { seq: number; type: "reload" }
  | { seq: number; type: "use"; use: "breach" }
  | { seq: number; type: "gadget"; gadget: GadgetKind; target: Vec2; angle?: number };

type ActionRejectReason = NonNullable<ActionResult["reason"]>;

type DeployResult = { accepted: true } | { accepted: false; reason: ActionRejectReason };

interface PlayerSlot {
  id: PlayerId;
  connected: boolean;
  debug: boolean;
  reconnectToken: string;
  inputState: InputState;
  pendingActions: PendingAction[];
  seenActionSeqs: Set<string>;
  actionResults: ActionResult[];
  explored: Vec2[];
  nextFireTick: number;
  nextActionTick: number;
  lastSeenWalls: Map<string, Wall>;
  lastSeenCameras: Map<string, DeployedCamera>;
}

export interface RoomState {
  id: string;
  map: MapDefinition;
  baseMap: MapDefinition;
  createdAtMs: number;
  tick: number;
  round: ServerSnapshot["round"];
  players: Record<PlayerId, PlayerState>;
  slots: Record<PlayerId, PlayerSlot>;
  detections: Detection[];
  shotImpacts: ShotImpact[];
  deployedCameras: DeployedCamera[];
  molotovs: MolotovZone[];
  smokes: SmokeZone[];
  soundSensors: SoundSensorZone[];
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
        hp: PLAYER_MAX_HP,
        ammo: MAG_SIZE,
        magSize: MAG_SIZE,
        isReloading: false,
        walking: false,
        gadgets: { ...GADGET_LOADOUT }
      }
    ])
  ) as Record<PlayerId, PlayerState>;

  return {
    id,
    map,
    baseMap,
    createdAtMs: Date.now(),
    tick: 0,
    round: { phase: "lobby", roundNumber: 1, scores: { p1: 0, p2: 0 }, startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS },
    players,
    slots: { p1: createSlot("p1"), p2: createSlot("p2") },
    detections: [],
    shotImpacts: [],
    deployedCameras: [],
    molotovs: [],
    smokes: [],
    soundSensors: [],
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
    inputState: { move: { x: 0, y: 0 }, aim: 0, fire: false, walk: false },
    pendingActions: [],
    seenActionSeqs: new Set(),
    actionResults: [],
    explored: [],
    nextFireTick: 0,
    nextActionTick: 0,
    lastSeenWalls: new Map(),
    lastSeenCameras: new Map()
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
  const slot = room.slots[playerId];
  slot.inputState = { move: command.move, aim: command.aim, fire: command.fire, walk: Boolean(command.walk) };
  enqueueCommandActions(slot, command);
  room.replay.commands.push({ ...command, playerId });
}

function enqueueCommandActions(slot: PlayerSlot, command: PlayerCommand): void {
  const actions: PendingAction[] = [];
  if (command.reload) actions.push({ seq: command.seq, type: "reload" });
  if (command.use === "breach") actions.push({ seq: command.seq, type: "use", use: "breach" });
  if (command.gadget && command.gadget !== "none" && command.gadgetTarget) {
    actions.push({ seq: command.seq, type: "gadget", gadget: command.gadget, target: command.gadgetTarget, ...(command.gadgetAngle !== undefined ? { angle: command.gadgetAngle } : {}) });
  }
  for (const action of actions) {
    const actionKey = `${action.seq}:${action.type}`;
    if (slot.seenActionSeqs.has(actionKey)) continue;
    slot.seenActionSeqs.add(actionKey);
    slot.pendingActions.push(action);
  }
  if (slot.seenActionSeqs.size > 256) {
    slot.seenActionSeqs = new Set([...slot.seenActionSeqs].slice(-128));
  }
}

function rejectPendingActions(room: RoomState, reason: ActionRejectReason): void {
  for (const slot of Object.values(room.slots)) {
    while (slot.pendingActions.length > 0) {
      const action = slot.pendingActions.shift()!;
      recordActionResult(slot, action.seq, action.type, false, reason);
    }
  }
}

function processPendingActions(room: RoomState, player: PlayerState, slot: PlayerSlot): void {
  while (slot.pendingActions.length > 0) {
    const action = slot.pendingActions.shift()!;
    if (action.type === "reload") {
      const accepted = startReload(player, room.tick);
      recordActionResult(slot, action.seq, "reload", accepted, accepted ? undefined : "invalid");
      continue;
    }
    if (action.type === "use") {
      const accepted = breachNearestWall(room, player);
      recordActionResult(slot, action.seq, "use", accepted, accepted ? undefined : "invalid");
      continue;
    }
    if (room.tick < slot.nextActionTick) {
      recordActionResult(slot, action.seq, "gadget", false, "action-lockout");
      continue;
    }
    const result = deployGadget(room, player, action.gadget, action.target, action.angle ?? player.aim);
    recordActionResult(slot, action.seq, "gadget", result.accepted, result.accepted ? undefined : result.reason);
    if (!result.accepted) continue;
    slot.nextActionTick = room.tick + POST_GADGET_LOCKOUT_TICKS;
    slot.nextFireTick = Math.max(slot.nextFireTick, slot.nextActionTick);
  }
}

function recordActionResult(slot: PlayerSlot, seq: number, action: ActionResult["action"], accepted: boolean, reason?: ActionRejectReason): void {
  slot.actionResults.push({ seq, action, accepted, ...(reason ? { reason } : {}) });
  slot.actionResults = slot.actionResults.slice(-32);
}

export function stepRoom(room: RoomState): void {
  room.tick += 1;
  room.shotImpacts = room.shotImpacts.filter((impact) => impact.tick >= room.tick - 5);
  room.molotovs = room.molotovs.filter((zone) => zone.expiresAtTick >= room.tick);
  room.smokes = room.smokes.filter((zone) => zone.expiresAtTick >= room.tick);
  room.soundSensors = room.soundSensors.filter((zone) => !zone.destroyed);
  if (room.round.phase === "ended") return;
  if (room.round.phase === "countdown" && room.tick >= room.round.startsAtTick) {
    room.round.phase = "active";
    delete room.round.winner;
    delete room.round.reason;
    delete room.round.nextRoundStartsAtTick;
    pushEvent(room, { type: "round-start", tick: room.tick });
  }
  if (room.round.phase !== "active") {
    integrateDoors(room);
    rejectPendingActions(room, "round-inactive");
    return;
  }

  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;
    const slot = room.slots[player.id];
    const input = slot.inputState;
    completeReload(player, room.tick);
    player.walking = Boolean(input.walk);
    const speed = player.walking ? PLAYER_WALK_SPEED : PLAYER_SPEED;
    const delta = { x: input.move.x * speed, y: input.move.y * speed };
    const desired = add(player.position, delta);
    collectDoorPushes(room, player.position, desired, delta);
    const next = movePlayerWithSweptCollision(room.map, player.position, desired, PLAYER_RADIUS);
    player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
    player.position = next;
    player.aim = input.aim;
    processPendingActions(room, player, slot);
    if (input.fire && room.tick >= slot.nextActionTick) resolveShot(room, player.id);
    room.analytics.push({ type: "movement-sample", tick: room.tick, data: { playerId: player.id, position: player.position } });
  }
  integrateDoors(room);
  resolvePlayerDoorOverlaps(room);

  resolveSensors(room);
  resolveSoundSensors(room);
  resolveMolotovDamage(room);
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
        restAngle: withHp.restAngle ?? 0,
        targetAngle: withHp.targetAngle ?? 0,
        currentAngle: withHp.currentAngle ?? 0,
        angularVelocity: withHp.angularVelocity ?? 0,
        lastPushTick: withHp.lastPushTick ?? 0,
        pushContactTicks: withHp.pushContactTicks ?? 0,
        lastPushSign: withHp.lastPushSign ?? 0,
        blockedUntilTick: withHp.blockedUntilTick ?? 0,
        blocksMovement: true,
        blocksVision: true,
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

function collectDoorPushes(room: RoomState, current: Vec2, desired: Vec2, delta: Vec2): void {
  const moveDistance = Math.hypot(delta.x, delta.y);
  if (moveDistance < 0.01) return;
  for (const door of room.map.walls) {
    if (door.kind !== "door" || !door.hinge || door.destroyed) continue;
    const threshold = PLAYER_RADIUS + door.thickness / 2 + DOOR_PUSH_SKIN;
    const currentDistance = distanceToSegment(current, door.a, door.b);
    const desiredDistance = distanceToSegment(desired, door.a, door.b);
    const contact = currentDistance <= threshold || desiredDistance <= threshold || Boolean(lineIntersection(current, desired, door.a, door.b));
    if (!contact) continue;
    const reference = desiredDistance <= currentDistance ? desired : current;
    const closest = closestPointOnSegment(reference, door.a, door.b);
    const awayFromPanel = normalFromSegmentToPoint(reference, door.a, door.b);
    const pushIntoPanel = -(delta.x * awayFromPanel.x + delta.y * awayFromPanel.y);
    const crossingPanel = Boolean(lineIntersection(current, desired, door.a, door.b));
    if (pushIntoPanel <= 0.01 && !crossingPanel) continue;
    const hingeToContact = { x: closest.x - door.hinge.x, y: closest.y - door.hinge.y };
    const torque = cross(hingeToContact, delta);
    if (Math.abs(torque) < 0.001) continue;
    const panelLength = Math.max(1, distance(door.hinge, door.b));
    const normalizedTorque = Math.max(-1, Math.min(1, torque / Math.max(1, panelLength * moveDistance)));
    const closeness = Math.max(0.35, 1 - Math.min(currentDistance, desiredDistance) / Math.max(1, threshold));
    const pushSign = Math.sign(normalizedTorque);
    door.pushContactTicks = door.lastPushSign === pushSign && room.tick - (door.lastPushTick ?? -9999) <= 1 ? (door.pushContactTicks ?? 0) + 1 : 1;
    door.lastPushSign = pushSign;
    const contactScale = door.pushContactTicks >= 2 ? 1 : 0.35;
    const rawImpulse = normalizedTorque * DOOR_PUSH_STRENGTH * closeness * contactScale;
    const impulse = Math.max(-DOOR_MAX_ANGULAR_ACCELERATION, Math.min(DOOR_MAX_ANGULAR_ACCELERATION, rawImpulse));
    door.angularVelocity = clampDoorSpeed((door.angularVelocity ?? 0) + impulse);
    door.targetAngle = Math.max(-DOOR_MAX_ANGLE, Math.min(DOOR_MAX_ANGLE, (door.currentAngle ?? 0) + impulse * 7));
    door.lastPushTick = room.tick;
  }
}

function movePlayerWithSweptCollision(map: MapDefinition, current: Vec2, desired: Vec2, radius: number): Vec2 {
  const totalDistance = distance(current, desired);
  const steps = Math.max(1, Math.ceil(totalDistance / Math.max(1, radius * 0.3)));
  let position = current;
  for (let step = 1; step <= steps; step += 1) {
    const target = {
      x: current.x + ((desired.x - current.x) * step) / steps,
      y: current.y + ((desired.y - current.y) * step) / steps
    };
    const next = moveWithCapsuleCollision(map, position, target, radius);
    if (next === position) return position;
    position = next;
  }
  return position;
}

function moveWithCapsuleCollision(map: MapDefinition, current: Vec2, desired: Vec2, radius: number): Vec2 {
  let resolved = {
    x: Math.max(radius, Math.min(map.bounds.width - radius, desired.x)),
    y: Math.max(radius, Math.min(map.bounds.height - radius, desired.y))
  };
  for (const wall of map.walls) {
    if (!wall.blocksMovement || wall.destroyed) continue;
    const threshold = radius + wall.thickness / 2 + (wall.kind === "door" ? DOOR_COLLISION_SKIN : 0);
    const closest = closestPointOnSegment(resolved, wall.a, wall.b);
    const separation = { x: resolved.x - closest.x, y: resolved.y - closest.y };
    const separationDistance = Math.hypot(separation.x, separation.y);
    const crossed = lineIntersection(current, resolved, wall.a, wall.b);
    if (separationDistance >= threshold && (!crossed || wall.kind === "door")) continue;
    const normal = separationDistance > 0.0001 ? { x: separation.x / separationDistance, y: separation.y / separationDistance } : normalFromSegmentToPoint(current, wall.a, wall.b);
    const overlap = separationDistance < threshold ? threshold - separationDistance : 0;
    if (overlap <= 0 && wall.kind === "door") continue;
    resolved = {
      x: Math.max(radius, Math.min(map.bounds.width - radius, resolved.x + normal.x * (overlap + 0.01))),
      y: Math.max(radius, Math.min(map.bounds.height - radius, resolved.y + normal.y * (overlap + 0.01)))
    };
  }
  return resolved;
}

function integrateDoors(room: RoomState): void {
  for (const door of room.map.walls) {
    if (door.kind !== "door" || !door.hinge || !door.closedB || door.destroyed) continue;
    const restAngle = door.restAngle ?? 0;
    const recentlyPushed = room.tick - (door.lastPushTick ?? -9999) <= 8;
    const target = recentlyPushed ? (door.targetAngle ?? door.currentAngle ?? restAngle) : restAngle;
    const springStrength = recentlyPushed ? DOOR_RETURN_STRENGTH * 0.25 : DOOR_RETURN_STRENGTH;
    door.angularVelocity = clampDoorSpeed((door.angularVelocity ?? 0) + (target - (door.currentAngle ?? 0)) * springStrength);
    for (let substep = 0; substep < DOOR_COLLISION_SUBSTEPS; substep += 1) {
      const previousAngle = door.currentAngle ?? 0;
      const previousB = door.b;
      const angle = Math.max(-DOOR_MAX_ANGLE, Math.min(DOOR_MAX_ANGLE, previousAngle + (door.angularVelocity ?? 0) / DOOR_COLLISION_SUBSTEPS));
      const nextB = rotateDoorEndpoint(door.hinge, door.closedB, angle);
      if (doorWouldPushIntoPlayer(room, door, nextB) || doorWouldHitWall(room, door, nextB)) {
        door.currentAngle = previousAngle;
        door.angularVelocity = 0;
        door.targetAngle = previousAngle;
        door.blockedUntilTick = room.tick + 4;
        door.lastPushTick = room.tick - 99;
        door.a = door.hinge;
        door.b = previousB;
        break;
      }
      door.currentAngle = angle;
      door.a = door.hinge;
      door.b = nextB;
    }
    door.angularVelocity = (door.angularVelocity ?? 0) * DOOR_DAMPING;
    if (Math.abs(door.angularVelocity) < 0.0005) door.angularVelocity = 0;
  }
}

function resolvePlayerDoorOverlaps(room: RoomState): void {
  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;
    let position = player.position;
    for (const door of room.map.walls) {
      if (door.kind !== "door" || door.destroyed || !door.blocksMovement) continue;
      const threshold = PLAYER_RADIUS + door.thickness / 2 + DOOR_COLLISION_SKIN;
      const closest = closestPointOnSegment(position, door.a, door.b);
      const separation = { x: position.x - closest.x, y: position.y - closest.y };
      const separationDistance = Math.hypot(separation.x, separation.y);
      if (separationDistance >= threshold) continue;
      const normal = separationDistance > 0.0001 ? { x: separation.x / separationDistance, y: separation.y / separationDistance } : normalFromSegmentToPoint(position, door.a, door.b);
      const push = threshold - separationDistance + 0.01;
      position = {
        x: Math.max(PLAYER_RADIUS, Math.min(room.map.bounds.width - PLAYER_RADIUS, position.x + normal.x * push)),
        y: Math.max(PLAYER_RADIUS, Math.min(room.map.bounds.height - PLAYER_RADIUS, position.y + normal.y * push))
      };
    }
    player.velocity = { x: player.velocity.x + position.x - player.position.x, y: player.velocity.y + position.y - player.position.y };
    player.position = position;
  }
}

function doorWouldHitWall(room: RoomState, door: MapDefinition["walls"][number], nextB: Vec2): boolean {
  if (!door.hinge) return false;
  const threshold = door.thickness / 2;
  return room.map.walls.some((wall) => {
    if (wall.id === door.id || wall.destroyed || !wall.blocksMovement) return false;
    if (wall.kind === "door" && (!wall.hinge || !wall.closedB)) return false;
    if (wallSharesDoorFramePoint(door, wall, threshold + wall.thickness / 2 + 2)) return false;
    return segmentsOverlapWithThickness(door.hinge!, nextB, wall.a, wall.b, threshold + wall.thickness / 2);
  });
}

function wallSharesDoorFramePoint(door: MapDefinition["walls"][number], wall: MapDefinition["walls"][number], tolerance: number): boolean {
  if (!door.hinge || !door.closedB) return false;
  return [wall.a, wall.b].some((point) => distance(point, door.hinge!) <= tolerance || distance(point, door.closedB!) <= tolerance);
}

function segmentsOverlapWithThickness(a: Vec2, b: Vec2, c: Vec2, d: Vec2, threshold: number): boolean {
  if (lineIntersection(a, b, c, d)) return true;
  return distanceToSegment(a, c, d) < threshold || distanceToSegment(b, c, d) < threshold || distanceToSegment(c, a, b) < threshold || distanceToSegment(d, a, b) < threshold;
}

function closestPointOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const lengthSq = ab.x * ab.x + ab.y * ab.y;
  if (lengthSq <= 0.000001) return { ...a };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lengthSq));
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function normalFromSegmentToPoint(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const closest = closestPointOnSegment(point, a, b);
  const delta = { x: point.x - closest.x, y: point.y - closest.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length > 0.0001) return { x: delta.x / length, y: delta.y / length };
  const segment = normalize({ x: b.x - a.x, y: b.y - a.y });
  return { x: -segment.y, y: segment.x };
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

function clampDoorSpeed(value: number): number {
  return Math.max(-DOOR_MAX_ANGULAR_SPEED, Math.min(DOOR_MAX_ANGULAR_SPEED, value));
}

function doorWouldPushIntoPlayer(room: RoomState, door: MapDefinition["walls"][number], nextB: Vec2): boolean {
  if (!door.hinge) return false;
  const threshold = PLAYER_RADIUS + door.thickness / 2;
  return Object.values(room.players).some((player) => {
    if (!player.alive) return false;
    const currentDistance = distanceToSegment(player.position, door.a, door.b);
    const nextDistance = distanceToSegment(player.position, door.hinge!, nextB);
    return nextDistance < threshold && nextDistance < currentDistance - 0.25;
  });
}

function rotateDoorEndpoint(hinge: Vec2, closedB: Vec2, angle: number): Vec2 {
  const length = distance(hinge, closedB);
  const base = Math.atan2(closedB.y - hinge.y, closedB.x - hinge.x);
  return add(hinge, mul(angleToVector(base + angle), length));
}

function completeReload(player: PlayerState, tick: number): void {
  if (!player.isReloading || player.reloadEndsAtTick === undefined || tick < player.reloadEndsAtTick) return;
  player.ammo = player.magSize;
  player.isReloading = false;
  delete player.reloadEndsAtTick;
}

function startReload(player: PlayerState, tick: number): boolean {
  if (player.isReloading || player.ammo >= player.magSize) return false;
  player.isReloading = true;
  player.reloadEndsAtTick = tick + RELOAD_TICKS;
  return true;
}

function deployGadget(room: RoomState, player: PlayerState, gadget: GadgetKind, target: Vec2, angle: number): DeployResult {
  if (player.gadgets[gadget] <= 0) return { accepted: false, reason: "no-count" };
  const maxRange = gadget === "camera" ? CAMERA_RANGE : gadget === "wall" ? DEPLOYABLE_WALL_RANGE : gadget === "smoke" ? SMOKE_RANGE : MOLOTOV_RANGE;
  const range = gadget === "sound" ? SOUND_SENSOR_RANGE : maxRange;
  const thrown = gadget === "molotov" || gadget === "smoke" ? resolveThrownTarget(room.map, player.position, target, range) : undefined;
  const position = thrown?.position ?? clampTarget(room.map, player.position, target, range);
  if (thrown && !thrown.valid) return { accepted: false, reason: "out-of-range" };
  if (!hasPlacementLineOfSight(room.map, player.position, position)) return { accepted: false, reason: "blocked-los" };
  if ((gadget === "camera" || gadget === "sound" || gadget === "wall") && !isPlacementClear(room.map, position, gadget === "wall" ? PLAYER_RADIUS : 7)) return { accepted: false, reason: "invalid" };
  player.gadgets[gadget] -= 1;
  if (gadget === "camera") {
    const camera: DeployedCamera = { id: `${player.id}-cam-${room.tick}-${room.deployedCameras.length}`, owner: player.id, position, radius: CAMERA_RADIUS, hp: 1 };
    room.deployedCameras.push(camera);
    room.slots[player.id].lastSeenCameras.set(camera.id, structuredClone(camera));
    pushEvent(room, { type: "camera-deployed", tick: room.tick, playerId: player.id, cameraId: camera.id });
    return { accepted: true };
  } else if (gadget === "molotov") {
    const zone: MolotovZone = { id: `${player.id}-molotov-${room.tick}-${room.molotovs.length}`, owner: player.id, position, radius: MOLOTOV_RADIUS, createdAtTick: room.tick, expiresAtTick: room.tick + MOLOTOV_TICKS };
    room.molotovs.push(zone);
    pushEvent(room, { type: "molotov-deployed", tick: room.tick, playerId: player.id, molotovId: zone.id });
    return { accepted: true };
  } else if (gadget === "smoke") {
    const zone: SmokeZone = { id: `${player.id}-smoke-${room.tick}-${room.smokes.length}`, owner: player.id, position, radius: SMOKE_RADIUS, createdAtTick: room.tick, expiresAtTick: room.tick + SMOKE_TICKS };
    room.smokes.push(zone);
    pushEvent(room, { type: "smoke-deployed", tick: room.tick, playerId: player.id, smokeId: zone.id });
    return { accepted: true };
  } else if (gadget === "sound") {
    const sensor: SoundSensorZone = { id: `${player.id}-sound-${room.tick}-${room.soundSensors.length}`, owner: player.id, position, radius: SOUND_SENSOR_RADIUS, hp: 1, createdAtTick: room.tick };
    room.soundSensors.push(sensor);
    pushEvent(room, { type: "sound-sensor-deployed", tick: room.tick, playerId: player.id, sensorId: sensor.id });
    return { accepted: true };
  } else {
    const wall = createDeployableWall(`${player.id}-wall-${room.tick}-${room.map.walls.length}`, position, angle);
    room.map.walls.push(wall);
    room.slots[player.id].lastSeenWalls.set(wall.id, structuredClone(wall));
    pushEvent(room, { type: "deployable-wall-deployed", tick: room.tick, playerId: player.id, wallId: wall.id });
    return { accepted: true };
  }
}

function resolveShot(room: RoomState, shooterId: PlayerId): void {
  const slot = room.slots[shooterId];
  if (room.tick < slot.nextFireTick) return;
  const shooter = room.players[shooterId];
  if (!shooter.alive) return;
  completeReload(shooter, room.tick);
  if (shooter.isReloading) return;
  if (shooter.ammo <= 0) {
    startReload(shooter, room.tick);
    return;
  }
  shooter.ammo -= 1;
  slot.nextFireTick = room.tick + FIRE_COOLDOWN_TICKS;
  const origin = { ...shooter.position };
  const rayEnd = add(origin, mul(angleToVector(shooter.aim), FIRE_RANGE));
  const hit = resolveHitscan(room, shooterId, origin, rayEnd);
  const impact: ShotImpact = { id: `${shooterId}-${room.tick}-${room.shotImpacts.length}`, tick: room.tick, shooter: shooterId, origin, end: hit.end, hit: hit.kind, ...(hit.targetId ? { targetId: hit.targetId } : {}), ...(hit.wallId ? { wallId: hit.wallId } : {}), ...(hit.cameraId ? { cameraId: hit.cameraId } : {}), ...(hit.soundSensorId ? { soundSensorId: hit.soundSensorId } : {}) };
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
  } else if (hit.kind === "camera" && hit.cameraId) {
    damageCamera(room, hit.cameraId, shooterId);
  } else if (hit.kind === "sound-sensor" && hit.soundSensorId) {
    damageSoundSensor(room, hit.soundSensorId, shooterId);
  }
}

function resolveHitscan(room: RoomState, shooterId: PlayerId, origin: Vec2, rayEnd: Vec2): { kind: ShotImpact["hit"]; end: Vec2; targetId?: PlayerId; wallId?: string; cameraId?: string; soundSensorId?: string } {
  const direction = normalize({ x: rayEnd.x - origin.x, y: rayEnd.y - origin.y });
  let nearest: { kind: ShotImpact["hit"]; distance: number; end: Vec2; targetId?: PlayerId; wallId?: string; cameraId?: string; soundSensorId?: string } = { kind: "none", distance: FIRE_RANGE, end: rayEnd };
  const targetId: PlayerId = shooterId === "p1" ? "p2" : "p1";
  const target = room.players[targetId];
  const playerDistance = target.alive ? rayCircleDistance(origin, direction, target.position, PLAYER_RADIUS) : null;
  if (playerDistance !== null) nearest = { kind: "player", distance: playerDistance, end: add(origin, mul(direction, playerDistance)), targetId };

  for (const camera of room.deployedCameras) {
    if (camera.destroyed) continue;
    const cameraDistance = rayCircleDistance(origin, direction, camera.position, CAMERA_HIT_RADIUS);
    if (cameraDistance !== null && cameraDistance < nearest.distance) {
      nearest = { kind: "camera", distance: cameraDistance, end: add(origin, mul(direction, cameraDistance)), cameraId: camera.id };
    }
  }

  for (const sensor of room.soundSensors) {
    if (sensor.destroyed) continue;
    const sensorDistance = rayCircleDistance(origin, direction, sensor.position, SOUND_SENSOR_HIT_RADIUS);
    if (sensorDistance !== null && sensorDistance < nearest.distance) {
      nearest = { kind: "sound-sensor", distance: sensorDistance, end: add(origin, mul(direction, sensorDistance)), soundSensorId: sensor.id };
    }
  }

  for (const wall of room.map.walls) {
    if (wall.destroyed) continue;
    const hit = lineIntersection(origin, rayEnd, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (wall.destructible && wall.kind === "mesh") {
      damageWall(room, wall.id, shooterId);
      continue;
    }
    const blocksShot = wall.kind === "door" || wall.kind === "transparent" || wall.blocksVision || wall.kind === "solid";
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
    room.slots[shooterId].lastSeenWalls.set(wall.id, structuredClone(wall));
    pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: wall.id, playerId: shooterId });
  }
}

function damageCamera(room: RoomState, cameraId: string, shooterId: PlayerId): void {
  const camera = room.deployedCameras.find((candidate) => candidate.id === cameraId);
  if (!camera || camera.destroyed) return;
  camera.hp = 0;
  camera.destroyed = true;
  room.slots[shooterId].lastSeenCameras.set(camera.id, structuredClone(camera));
  room.slots[camera.owner].lastSeenCameras.set(camera.id, structuredClone(camera));
  pushEvent(room, { type: "camera-destroyed", tick: room.tick, playerId: shooterId, cameraId: camera.id });
}

function damageSoundSensor(room: RoomState, sensorId: string, _shooterId: PlayerId): void {
  const sensor = room.soundSensors.find((candidate) => candidate.id === sensorId);
  if (!sensor || sensor.destroyed) return;
  sensor.hp = 0;
  sensor.destroyed = true;
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
  resetRoundWorld(room);
  resetPlayersForRound(room);
}

function resetRoundWorld(room: RoomState): void {
  room.map = initializeRuntimeMap(structuredClone(room.baseMap));
  room.detections = [];
  room.shotImpacts = [];
  room.deployedCameras = [];
  room.molotovs = [];
  room.smokes = [];
  room.soundSensors = [];
}

function resetPlayersForRound(room: RoomState): void {
  for (const spawn of room.map.spawns) {
    const player = room.players[spawn.id];
    player.position = { ...spawn.position };
    player.velocity = { x: 0, y: 0 };
    player.aim = spawn.angle;
    player.alive = true;
    player.hp = PLAYER_MAX_HP;
    player.ammo = MAG_SIZE;
    player.magSize = MAG_SIZE;
    player.isReloading = false;
    player.walking = false;
    delete player.reloadEndsAtTick;
    player.gadgets = { ...GADGET_LOADOUT };
    room.slots[player.id].inputState = { move: { x: 0, y: 0 }, aim: spawn.angle, fire: false, walk: false };
    room.slots[player.id].pendingActions = [];
    room.slots[player.id].seenActionSeqs.clear();
    room.slots[player.id].actionResults = [];
    room.slots[player.id].nextFireTick = room.tick;
    room.slots[player.id].nextActionTick = room.tick;
    room.slots[player.id].lastSeenWalls.clear();
    room.slots[player.id].lastSeenCameras.clear();
  }
}

function resetMatch(room: RoomState): void {
  room.tick = 0;
  room.round = { phase: "countdown", roundNumber: 1, scores: { p1: 0, p2: 0 }, startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS };
  room.rematchRequests.clear();
  resetRoundWorld(room);
  resetPlayersForRound(room);
}

export function isExpiredUnfilledLobby(room: RoomState, nowMs = Date.now()): boolean {
  const connected = Object.values(room.slots).filter((slot) => slot.connected).length;
  return room.round.phase === "lobby" && connected < 2 && nowMs - room.createdAtMs >= 60_000;
}

function resolveMolotovDamage(room: RoomState): void {
  for (const zone of room.molotovs) {
    const age = room.tick - zone.createdAtTick;
    if (age <= 0 || age % MOLOTOV_DAMAGE_INTERVAL !== 0) continue;
    for (const player of Object.values(room.players)) {
      if (!player.alive || distance(player.position, zone.position) > zone.radius) continue;
      if (!hasLineOfSight(room.map, zone.position, player.position)) continue;
      player.hp = Math.max(0, player.hp - 1);
      if (player.hp <= 0) {
        player.alive = false;
        pushEvent(room, { type: "kill", tick: room.tick, shooter: zone.owner, target: player.id });
        finishRound(room, zone.owner, "kill");
        return;
      }
    }
  }
}

function resolveSoundSensors(room: RoomState): void {
  for (const sensor of room.soundSensors) {
    if (sensor.destroyed) continue;
    const target = room.players[sensor.owner === "p1" ? "p2" : "p1"];
    const speed = Math.hypot(target.velocity.x, target.velocity.y);
    const triggered = target.alive && !target.walking && speed >= SOUND_SENSOR_SPEED_THRESHOLD && distance(sensor.position, target.position) <= sensor.radius;
    if (!triggered) continue;
    sensor.triggeredUntilTick = room.tick + SOUND_SENSOR_TRIGGER_TICKS;
    const detection: Detection = {
      id: `${sensor.id}-${room.tick}`,
      kind: "sound-area",
      position: { ...sensor.position },
      radius: sensor.radius,
      confidence: 0.72,
      expiresAtTick: room.tick + SOUND_SENSOR_TRIGGER_TICKS,
      owner: sensor.owner,
      targetId: target.id
    };
    room.detections.push(detection);
    pushEvent(room, { type: "sensor-detect", tick: room.tick, sensorId: sensor.id, target: target.id, confidence: detection.confidence });
  }
}

function breachNearestWall(room: RoomState, player: PlayerState): boolean {
  const target = room.map.walls
    .filter((wall) => wall.destructible && wall.kind !== "door" && !wall.destroyed)
    .map((wall) => ({ wall, distance: distanceToSegment(player.position, wall.a, wall.b) }))
    .filter(({ distance: wallDistance }) => wallDistance <= 52)
    .sort((a, b) => a.distance - b.distance)[0]?.wall;
  if (!target) return false;
  target.destroyed = true;
  pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: target.id, playerId: player.id });
  return true;
}

function resolveSensors(room: RoomState): void {
  for (const sensor of room.map.sensors) {
    if (sensor.destroyed || sensor.corrupted) continue;
    const target = room.players[sensor.owner === "p1" ? "p2" : "p1"];
    if (!target.alive) continue;
    const seesTarget = sensor.kind === "camera"
      ? pointInCone(sensor.position, sensor.angle, sensor.fov, sensor.range, target.position) && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position)
      : distance(sensor.position, target.position) <= sensor.range && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position) && room.tick % 20 === 0;
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
  completeReload(self, room.tick);
  const opponentId: PlayerId = playerId === "p1" ? "p2" : "p1";
  const opponent = room.players[opponentId];
  const debug = room.slots[playerId].debug;
  const visiblePlayers: PlayerState[] = [];
  if (opponent.alive && isPointVisibleToPlayer(room, self, opponent.position)) {
    visiblePlayers.push({ ...opponent, position: { ...opponent.position }, velocity: { ...opponent.velocity } });
  }
  const polygon = visibleConePolygonWithSmoke(room.map, room.smokes, self.position, self.aim, VIEW_FOV, VIEW_RANGE, 54);
  room.slots[playerId].explored.push(...polygon.filter((_, index) => index % 8 === 0));
  room.slots[playerId].explored = room.slots[playerId].explored.slice(-400);
  const visibleShotImpacts = room.shotImpacts.filter((impact) => {
    if (impact.shooter === playerId) return true;
    return isPointVisibleToPlayer(room, self, impact.origin) || isPointVisibleToPlayer(room, self, impact.end);
  });
  const visibleCameras = visibleCamerasFor(room, playerId);
  const visibleMolotovs = room.molotovs.filter((zone) => zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position));
  const visibleSmokes = room.smokes.filter((zone) => zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position));
  const visibleSoundSensors = room.soundSensors.filter((zone) => !zone.destroyed && (zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position)));

  const snapshot: ServerSnapshot = {
    type: "snapshot",
    tick: room.tick,
    playerId,
    round: { ...room.round, scores: { ...room.round.scores } },
    self: { ...self, position: { ...self.position }, velocity: { ...self.velocity } },
    visiblePlayers,
    detections: debug ? room.detections : room.detections.filter((detection) => detection.owner === playerId || isPointVisibleToPlayer(room, self, detection.position)),
    map: { walls: debug ? room.map.walls : wallsForPlayer(room, playerId), sensors: debug ? room.map.sensors : [] },
    gadgets: { cameras: visibleCameras, molotovs: visibleMolotovs, smokes: visibleSmokes, soundSensors: visibleSoundSensors },
    shotImpacts: visibleShotImpacts,
    visiblePolygon: polygon,
    visibleCircles: room.deployedCameras.filter((camera) => camera.owner === playerId && !camera.destroyed).map((camera) => ({ position: camera.position, radius: camera.radius })),
    explored: room.slots[playerId].explored,
    actionResults: room.slots[playerId].actionResults.slice(-12)
  };

  if (debug) {
    snapshot.debug = {
      players: Object.values(room.players),
      detections: room.detections,
      visibleByPlayer: {
        p1: visibleConePolygonWithSmoke(room.map, room.smokes, room.players.p1.position, room.players.p1.aim, VIEW_FOV, VIEW_RANGE, 48),
        p2: visibleConePolygonWithSmoke(room.map, room.smokes, room.players.p2.position, room.players.p2.aim, VIEW_FOV, VIEW_RANGE, 48)
      }
    };
  }
  return snapshot;
}

function isPointVisibleToPlayer(room: RoomState, player: PlayerState, point: Vec2): boolean {
  if (hasConeLineOfSightWithSmoke(room.map, room.smokes, player.position, player.aim, VIEW_FOV, VIEW_RANGE, point)) return true;
  return room.deployedCameras.some((camera) => camera.owner === player.id && !camera.destroyed && distance(camera.position, point) <= camera.radius && hasLineOfSightWithSmoke(room.map, room.smokes, camera.position, point));
}

function wallVisibleToPlayer(room: RoomState, player: PlayerState, wall: Wall): boolean {
  const midpoint = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
  return isPointVisibleToPlayer(room, player, wall.a) || isPointVisibleToPlayer(room, player, wall.b) || isPointVisibleToPlayer(room, player, midpoint);
}

function wallsForPlayer(room: RoomState, playerId: PlayerId): Wall[] {
  const player = room.players[playerId];
  const slot = room.slots[playerId];
  return room.map.walls.flatMap((wall) => {
    if (wallVisibleToPlayer(room, player, wall)) {
      const clone = structuredClone(wall);
      slot.lastSeenWalls.set(wall.id, clone);
      return [clone];
    }
    const lastSeen = slot.lastSeenWalls.get(wall.id);
    if (lastSeen) return [structuredClone(lastSeen)];
    const authored = room.baseMap.walls.find((candidate) => candidate.id === wall.id);
    return authored ? [structuredClone(authored)] : [];
  });
}

function visibleCamerasFor(room: RoomState, playerId: PlayerId): DeployedCamera[] {
  const player = room.players[playerId];
  const slot = room.slots[playerId];
  const visible: DeployedCamera[] = [];
  for (const camera of room.deployedCameras) {
    if (camera.owner === playerId || isPointVisibleToPlayer(room, player, camera.position)) {
      const clone = structuredClone(camera);
      slot.lastSeenCameras.set(camera.id, clone);
      visible.push(clone);
      continue;
    }
    const lastSeen = slot.lastSeenCameras.get(camera.id);
    if (lastSeen) visible.push(structuredClone(lastSeen));
  }
  return visible;
}

function pushEvent(room: RoomState, event: AuthoritativeEvent): void {
  room.replay.events.push(event);
}
