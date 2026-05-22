import {
  add,
  angleToVector,
  createPlayerClass,
  createWeapon,
  distance,
  distanceToSegment,
  isHingedDoorSegment,
  isShootableDestructibleSegment,
  hasLineOfSight,
  lineIntersection,
  mul,
  normalize,
  pointInCone,
  sampleMap,
  segmentBlocksMovement,
  segmentBlocksShooting,
  segmentPreset,
  type AuthoritativeEvent,
  type ActionResult,
  type ClientMessage,
  type DeployedCamera,
  type Detection,
  type GadgetKind,
  type MapDefinition,
  type MolotovZone,
  type PlayerCommand,
  type PlayerLoadoutSelection,
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
  DOOR_TOGGLE_RANGE,
  FIRE_RANGE,
  MOLOTOV_DAMAGE_INTERVAL,
  MOLOTOV_RANGE,
  MOLOTOV_RADIUS,
  MOLOTOV_TICKS,
  PLAYER_CLOSE_VISION_RADIUS,
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
  | { seq: number; type: "use"; use: "breach" | "door-toggle" }
  | { seq: number; type: "gadget"; gadget: GadgetKind; target: Vec2; angle?: number };

type ActionRejectReason = NonNullable<ActionResult["reason"]>;

type DeployResult = { accepted: true } | { accepted: false; reason: ActionRejectReason };

interface GadgetDeployAction {
  target: Vec2;
  angle: number;
}

interface ResolvedDeployTarget {
  position: Vec2;
}

interface GadgetStrategy {
  kind: GadgetKind;
  range: number;
  canDeploy(room: RoomState, player: PlayerState, action: GadgetDeployAction): DeployResult & Partial<ResolvedDeployTarget>;
  deploy(room: RoomState, player: PlayerState, action: GadgetDeployAction, resolved: ResolvedDeployTarget): DeployResult;
}

interface DesiredMovement {
  player: PlayerState;
  slot: PlayerSlot;
  input: InputState;
  desired: Vec2;
}

interface PlayerSlot {
  id: PlayerId;
  connected: boolean;
  debug: boolean;
  reconnectToken: string;
  pendingLoadout?: PlayerLoadoutSelection;
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

type PlayerRecord = Record<PlayerId, PlayerState> & { p1: PlayerState; p2: PlayerState };
type SlotRecord = Record<PlayerId, PlayerSlot> & { p1: PlayerSlot; p2: PlayerSlot };

export interface RoomState {
  id: string;
  map: MapDefinition;
  baseMap: MapDefinition;
  createdAtMs: number;
  tick: number;
  round: ServerSnapshot["round"];
  players: PlayerRecord;
  slots: SlotRecord;
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
  const playerIds = map.spawns.map((spawn) => spawn.id);
  const players = Object.fromEntries(
    map.spawns.map((spawn) => [
      spawn.id,
      {
        id: spawn.id,
        team: spawn.team,
        classId: "operator",
        className: "Operator",
        weaponId: "assault",
        weaponName: "Assault Rifle",
        gadgetLoadout: createPlayerClass().gadgets,
        position: { ...spawn.position },
        velocity: { x: 0, y: 0 },
        aim: spawn.angle,
        alive: true,
        hp: PLAYER_MAX_HP,
        ammo: createWeapon().magSize,
        magSize: createWeapon().magSize,
        isReloading: false,
        walking: false,
        gadgets: createPlayerClass().gadgets
      }
    ])
  ) as PlayerRecord;
  const slots = Object.fromEntries(playerIds.map((playerId) => [playerId, createSlot(playerId)])) as SlotRecord;

  return {
    id,
    map,
    baseMap,
    createdAtMs: Date.now(),
    tick: 0,
    round: { phase: "lobby", roundNumber: 1, scores: scoresForPlayers(playerIds), startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS },
    players,
    slots,
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

function playerIds(room: RoomState): PlayerId[] {
  return Object.keys(room.players) as PlayerId[];
}

function getPlayer(room: RoomState, id: PlayerId): PlayerState {
  const player = room.players[id];
  if (!player) throw new Error(`Unknown player ${id}`);
  return player;
}

function getSlot(room: RoomState, id: PlayerId): PlayerSlot {
  const slot = room.slots[id];
  if (!slot) throw new Error(`Unknown player slot ${id}`);
  return slot;
}

function enemyPlayers(room: RoomState, playerId: PlayerId): PlayerState[] {
  const player = getPlayer(room, playerId);
  return Object.values(room.players).filter((candidate) => candidate.id !== playerId && candidate.team !== player.team);
}

function scoresForPlayers(ids: PlayerId[]): Record<PlayerId, number> {
  return Object.fromEntries(ids.map((id) => [id, 0])) as Record<PlayerId, number>;
}

function applyPlayerLoadout(player: PlayerState, selection?: PlayerLoadoutSelection): void {
  const playerClass = createPlayerClass(selection);
  const weapon = createWeapon(selection);
  player.classId = playerClass.id;
  player.className = playerClass.name;
  player.weaponId = weapon.id;
  player.weaponName = weapon.name;
  player.gadgetLoadout = { ...playerClass.gadgets };
  player.gadgets = { ...playerClass.gadgets };
  player.magSize = weapon.magSize;
  player.ammo = Math.min(player.ammo, weapon.magSize);
}

export function joinRoom(room: RoomState, debug = false, preferred?: PlayerId, loadout?: PlayerLoadoutSelection): ServerWelcome | null {
  const playerId = preferred ?? Object.values(room.slots).find((candidate) => !candidate.connected)?.id ?? null;
  if (!playerId || room.round.matchWinner) return null;
  const slot = getSlot(room, playerId);
  applyPlayerLoadout(getPlayer(room, playerId), loadout);
  slot.connected = true;
  slot.debug = debug;
  if (Object.values(room.slots).every((candidate) => candidate.connected) && room.round.phase === "lobby") {
    room.round.phase = "countdown";
  }
  return { type: "welcome", playerId, roomId: room.id, reconnectToken: slot.reconnectToken, map: room.map };
}

export function applyClientMessage(room: RoomState, playerId: PlayerId, message: ClientMessage): void {
  if (message.type === "rematch") {
    room.rematchRequests.add(playerId);
    if (room.round.matchWinner && playerIds(room).every((id) => room.rematchRequests.has(id))) resetMatch(room);
    return;
  }
  if (message.type === "loadout") {
    getSlot(room, playerId).pendingLoadout = structuredClone(message.loadout);
    return;
  }
  if (message.type !== "command") return;
  const command = { ...message, move: normalize(message.move), tick: room.tick };
  const slot = getSlot(room, playerId);
  slot.inputState = { move: command.move, aim: command.aim, fire: command.fire, walk: Boolean(command.walk) };
  enqueueCommandActions(slot, command);
  room.replay.commands.push({ ...command, playerId });
}

function enqueueCommandActions(slot: PlayerSlot, command: PlayerCommand): void {
  const actions: PendingAction[] = [];
  if (command.reload) actions.push({ seq: command.seq, type: "reload" });
  if (command.use === "breach" || command.use === "door-toggle") actions.push({ seq: command.seq, type: "use", use: command.use });
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
      const accepted = action.use === "breach" ? breachNearestWall(room, player) : toggleNearestDoor(room, player);
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
    applyPendingLoadouts(room);
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

  const desiredMovements: DesiredMovement[] = [];
  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;
    const slot = getSlot(room, player.id);
    const input = slot.inputState;
    completeReload(player, room.tick);
    player.walking = Boolean(input.walk);
    const speed = player.walking ? PLAYER_WALK_SPEED : PLAYER_SPEED;
    const delta = { x: input.move.x * speed, y: input.move.y * speed };
    const desired = add(player.position, delta);
    collectDoorPushes(room, player.position, desired, delta);
    player.aim = input.aim;
    desiredMovements.push({ player, slot, input, desired });
  }
  integrateDoors(room);

  for (const { player, slot, input, desired } of desiredMovements) {
    const next = movePlayerWithSweptCollision(room.map, player.position, desired, PLAYER_RADIUS);
    player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
    player.position = next;
    processPendingActions(room, player, slot);
    if (input.fire && room.tick >= slot.nextActionTick) resolveShot(room, player.id);
    room.analytics.push({ type: "movement-sample", tick: room.tick, data: { playerId: player.id, position: player.position } });
  }
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
      if (!isHingedDoorSegment(withHp)) return withHp;
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
        blocksShooting: true,
        a: hinge,
        b: rotateDoorEndpoint(hinge, closedB, withHp.currentAngle ?? 0)
      };
    })
  };
}

function initializeWallHp(wall: MapDefinition["walls"][number]): MapDefinition["walls"][number] {
  if (!wall.destructible || isHingedDoorSegment(wall)) {
    const { hp: _hp, maxHp: _maxHp, ...runtimeWall } = wall;
    return runtimeWall;
  }
  const maxHp = wall.maxHp ?? (segmentPreset(wall) === "mesh" || segmentPreset(wall) === "window" ? 1 : 5);
  return { ...wall, maxHp, hp: wall.hp ?? maxHp };
}

function collectDoorPushes(room: RoomState, current: Vec2, desired: Vec2, delta: Vec2): void {
  const moveDistance = Math.hypot(delta.x, delta.y);
  if (moveDistance < 0.01) return;
  for (const door of room.map.walls) {
    if (!isHingedDoorSegment(door) || !door.hinge || door.destroyed) continue;
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
    delete door.targetAngle;
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
    if (!segmentBlocksMovement(wall)) continue;
    const threshold = radius + wall.thickness / 2 + (isHingedDoorSegment(wall) ? DOOR_COLLISION_SKIN : 0);
    const closest = closestPointOnSegment(resolved, wall.a, wall.b);
    const separation = { x: resolved.x - closest.x, y: resolved.y - closest.y };
    const separationDistance = Math.hypot(separation.x, separation.y);
    const crossed = lineIntersection(current, resolved, wall.a, wall.b);
    if (separationDistance >= threshold && (!crossed || isHingedDoorSegment(wall))) continue;
    const normal = separationDistance > 0.0001 ? { x: separation.x / separationDistance, y: separation.y / separationDistance } : normalFromSegmentToPoint(current, wall.a, wall.b);
    const overlap = separationDistance < threshold ? threshold - separationDistance : 0;
    if (overlap <= 0 && isHingedDoorSegment(wall)) continue;
    resolved = {
      x: Math.max(radius, Math.min(map.bounds.width - radius, resolved.x + normal.x * (overlap + 0.01))),
      y: Math.max(radius, Math.min(map.bounds.height - radius, resolved.y + normal.y * (overlap + 0.01)))
    };
  }
  return resolved;
}

function integrateDoors(room: RoomState): void {
  for (const door of room.map.walls) {
    if (!isHingedDoorSegment(door) || !door.hinge || !door.closedB || door.destroyed) continue;
    if (door.targetAngle !== undefined) {
      const delta = door.targetAngle - (door.currentAngle ?? 0);
      if (Math.abs(delta) < 0.015 && Math.abs(door.angularVelocity ?? 0) < 0.006) {
        door.currentAngle = door.targetAngle;
        door.a = door.hinge;
        door.b = rotateDoorEndpoint(door.hinge, door.closedB, door.currentAngle);
        door.angularVelocity = 0;
        delete door.targetAngle;
      } else {
        const desiredAcceleration = Math.sign(delta) * DOOR_MAX_ANGULAR_ACCELERATION;
        door.angularVelocity = clampDoorSpeed((door.angularVelocity ?? 0) + desiredAcceleration);
      }
    }
    door.angularVelocity = clampDoorSpeed(door.angularVelocity ?? 0);
    for (let substep = 0; substep < DOOR_COLLISION_SUBSTEPS; substep += 1) {
      const previousAngle = door.currentAngle ?? 0;
      const previousB = door.b;
      const angle = Math.max(-DOOR_MAX_ANGLE, Math.min(DOOR_MAX_ANGLE, previousAngle + (door.angularVelocity ?? 0) / DOOR_COLLISION_SUBSTEPS));
      const nextB = rotateDoorEndpoint(door.hinge, door.closedB, angle);
      if (doorWouldPushIntoPlayer(room, door, nextB) || doorWouldHitWall(room, door, nextB)) {
        door.currentAngle = previousAngle;
        door.angularVelocity = 0;
        delete door.targetAngle;
        door.blockedUntilTick = room.tick + 4;
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
      if (!isHingedDoorSegment(door) || !segmentBlocksMovement(door)) continue;
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
    if (wall.id === door.id || !segmentBlocksMovement(wall)) return false;
    if (isHingedDoorSegment(wall) && (!wall.hinge || !wall.closedB)) return false;
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

function toggleNearestDoor(room: RoomState, player: PlayerState): boolean {
  const door = room.map.walls
    .filter((candidate) => isHingedDoorSegment(candidate) && !candidate.destroyed && candidate.hinge && candidate.closedB)
    .map((candidate) => ({
      door: candidate,
      distance: Math.max(0, distanceToSegment(player.position, candidate.a, candidate.b) - PLAYER_RADIUS - candidate.thickness / 2)
    }))
    .filter(({ distance: doorDistance }) => doorDistance <= DOOR_TOGGLE_RANGE)
    .sort((a, b) => a.distance - b.distance)[0]?.door;
  if (!door?.hinge || !door.closedB) return false;

  const currentAngle = door.currentAngle ?? 0;
  if (Math.abs(currentAngle) > DOOR_MAX_ANGLE * 0.45) {
    door.targetAngle = 0;
    return true;
  }

  const hinge = door.hinge;
  const panel = { x: door.b.x - hinge.x, y: door.b.y - hinge.y };
  const playerOffset = { x: player.position.x - hinge.x, y: player.position.y - hinge.y };
  const side = cross(panel, playerOffset);
  const sign = Math.abs(side) > 0.001 ? -Math.sign(side) : Math.sign(Math.cos(player.aim)) || 1;
  door.targetAngle = sign * DOOR_MAX_ANGLE;
  return true;
}

const gadgetStrategies: Record<GadgetKind, GadgetStrategy> = {
  camera: {
    kind: "camera",
    range: CAMERA_RANGE,
    canDeploy: basicDeployCheck("camera", CAMERA_RANGE, 7),
    deploy(room, player, _action, resolved) {
      const camera: DeployedCamera = { id: `${player.id}-cam-${room.tick}-${room.deployedCameras.length}`, owner: player.id, position: resolved.position, radius: CAMERA_RADIUS, hp: 1 };
      room.deployedCameras.push(camera);
      getSlot(room, player.id).lastSeenCameras.set(camera.id, structuredClone(camera));
      pushEvent(room, { type: "camera-deployed", tick: room.tick, playerId: player.id, cameraId: camera.id });
      return { accepted: true };
    }
  },
  molotov: {
    kind: "molotov",
    range: MOLOTOV_RANGE,
    canDeploy: thrownDeployCheck(MOLOTOV_RANGE),
    deploy(room, player, _action, resolved) {
      const zone: MolotovZone = { id: `${player.id}-molotov-${room.tick}-${room.molotovs.length}`, owner: player.id, position: resolved.position, radius: MOLOTOV_RADIUS, createdAtTick: room.tick, expiresAtTick: room.tick + MOLOTOV_TICKS };
      room.molotovs.push(zone);
      pushEvent(room, { type: "molotov-deployed", tick: room.tick, playerId: player.id, molotovId: zone.id });
      return { accepted: true };
    }
  },
  smoke: {
    kind: "smoke",
    range: SMOKE_RANGE,
    canDeploy: thrownDeployCheck(SMOKE_RANGE),
    deploy(room, player, _action, resolved) {
      const zone: SmokeZone = { id: `${player.id}-smoke-${room.tick}-${room.smokes.length}`, owner: player.id, position: resolved.position, radius: SMOKE_RADIUS, createdAtTick: room.tick, expiresAtTick: room.tick + SMOKE_TICKS };
      room.smokes.push(zone);
      pushEvent(room, { type: "smoke-deployed", tick: room.tick, playerId: player.id, smokeId: zone.id });
      return { accepted: true };
    }
  },
  wall: {
    kind: "wall",
    range: DEPLOYABLE_WALL_RANGE,
    canDeploy: basicDeployCheck("wall", DEPLOYABLE_WALL_RANGE, PLAYER_RADIUS),
    deploy(room, player, action, resolved) {
      const wall = createDeployableWall(`${player.id}-wall-${room.tick}-${room.map.walls.length}`, resolved.position, action.angle);
      room.map.walls.push(wall);
      getSlot(room, player.id).lastSeenWalls.set(wall.id, structuredClone(wall));
      pushEvent(room, { type: "deployable-wall-deployed", tick: room.tick, playerId: player.id, wallId: wall.id });
      return { accepted: true };
    }
  },
  sound: {
    kind: "sound",
    range: SOUND_SENSOR_RANGE,
    canDeploy: basicDeployCheck("sound", SOUND_SENSOR_RANGE, 7),
    deploy(room, player, _action, resolved) {
      const sensor: SoundSensorZone = { id: `${player.id}-sound-${room.tick}-${room.soundSensors.length}`, owner: player.id, position: resolved.position, radius: SOUND_SENSOR_RADIUS, hp: 1, createdAtTick: room.tick };
      room.soundSensors.push(sensor);
      pushEvent(room, { type: "sound-sensor-deployed", tick: room.tick, playerId: player.id, sensorId: sensor.id });
      return { accepted: true };
    }
  }
};

function deployGadget(room: RoomState, player: PlayerState, gadget: GadgetKind, target: Vec2, angle: number): DeployResult {
  if (player.gadgets[gadget] <= 0) return { accepted: false, reason: "no-count" };
  const strategy = gadgetStrategies[gadget];
  const action = { target, angle };
  const canDeploy = strategy.canDeploy(room, player, action);
  if (!canDeploy.accepted || !canDeploy.position) return canDeploy.accepted ? { accepted: false, reason: "invalid" } : canDeploy;
  player.gadgets[gadget] -= 1;
  return strategy.deploy(room, player, action, { position: canDeploy.position });
}

function basicDeployCheck(_gadget: GadgetKind, range: number, clearRadius: number): GadgetStrategy["canDeploy"] {
  return (room, player, action) => {
    const position = clampTarget(room.map, player.position, action.target, range);
    if (!hasPlacementLineOfSight(room.map, player.position, position)) return { accepted: false, reason: "blocked-los" };
    if (!isPlacementClear(room.map, position, clearRadius)) return { accepted: false, reason: "invalid" };
    return { accepted: true, position };
  };
}

function thrownDeployCheck(range: number): GadgetStrategy["canDeploy"] {
  return (room, player, action) => {
    const thrown = resolveThrownTarget(room.map, player.position, action.target, range);
    if (!thrown.valid) return { accepted: false, reason: "out-of-range" };
    if (!hasPlacementLineOfSight(room.map, player.position, thrown.position)) return { accepted: false, reason: "blocked-los" };
    return { accepted: true, position: thrown.position };
  };
}

function resolveShot(room: RoomState, shooterId: PlayerId): void {
  const slot = getSlot(room, shooterId);
  if (room.tick < slot.nextFireTick) return;
  const shooter = getPlayer(room, shooterId);
  const weapon = createWeapon({ weaponId: shooter.weaponId });
  if (!shooter.alive) return;
  completeReload(shooter, room.tick);
  if (shooter.isReloading) return;
  if (shooter.ammo <= 0) {
    startReload(shooter, room.tick);
    return;
  }
  shooter.ammo -= 1;
  slot.nextFireTick = room.tick + weapon.fireCooldownTicks;
  const origin = { ...shooter.position };
  const rayEnd = add(origin, mul(angleToVector(shooter.aim), weapon.effectiveRange));
  const hit = resolveHitscan(room, shooterId, origin, rayEnd, weapon.effectiveRange);
  const impact: ShotImpact = { id: `${shooterId}-${room.tick}-${room.shotImpacts.length}`, tick: room.tick, shooter: shooterId, origin, end: hit.end, hit: hit.kind, ...(hit.targetId ? { targetId: hit.targetId } : {}), ...(hit.wallId ? { wallId: hit.wallId } : {}), ...(hit.cameraId ? { cameraId: hit.cameraId } : {}), ...(hit.soundSensorId ? { soundSensorId: hit.soundSensorId } : {}) };
  room.shotImpacts.push(impact);
  pushEvent(room, { type: "shot", tick: room.tick, impact });

  if (hit.kind === "player" && hit.targetId) {
    const target = getPlayer(room, hit.targetId);
    target.hp = Math.max(0, target.hp - weapon.damage);
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

function resolveHitscan(room: RoomState, shooterId: PlayerId, origin: Vec2, rayEnd: Vec2, maxRange = FIRE_RANGE): { kind: ShotImpact["hit"]; end: Vec2; targetId?: PlayerId; wallId?: string; cameraId?: string; soundSensorId?: string } {
  const direction = normalize({ x: rayEnd.x - origin.x, y: rayEnd.y - origin.y });
  let nearest: { kind: ShotImpact["hit"]; distance: number; end: Vec2; targetId?: PlayerId; wallId?: string; cameraId?: string; soundSensorId?: string } = { kind: "none", distance: maxRange, end: rayEnd };
  for (const target of enemyPlayers(room, shooterId)) {
    const playerDistance = target.alive ? rayCircleDistance(origin, direction, target.position, PLAYER_RADIUS, maxRange) : null;
    if (playerDistance !== null && playerDistance < nearest.distance) nearest = { kind: "player", distance: playerDistance, end: add(origin, mul(direction, playerDistance)), targetId: target.id };
  }

  for (const camera of room.deployedCameras) {
    if (camera.destroyed) continue;
    const cameraDistance = rayCircleDistance(origin, direction, camera.position, CAMERA_HIT_RADIUS, maxRange);
    if (cameraDistance !== null && cameraDistance < nearest.distance) {
      nearest = { kind: "camera", distance: cameraDistance, end: add(origin, mul(direction, cameraDistance)), cameraId: camera.id };
    }
  }

  for (const sensor of room.soundSensors) {
    if (sensor.destroyed) continue;
    const sensorDistance = rayCircleDistance(origin, direction, sensor.position, SOUND_SENSOR_HIT_RADIUS, maxRange);
    if (sensorDistance !== null && sensorDistance < nearest.distance) {
      nearest = { kind: "sound-sensor", distance: sensorDistance, end: add(origin, mul(direction, sensorDistance)), soundSensorId: sensor.id };
    }
  }

  for (const wall of room.map.walls) {
    if (wall.destroyed) continue;
    const hit = lineIntersection(origin, rayEnd, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (isShootableDestructibleSegment(wall) && !segmentBlocksShooting(wall)) {
      damageWall(room, wall.id, shooterId);
      continue;
    }
    if ((segmentBlocksShooting(wall) || isShootableDestructibleSegment(wall)) && hitDistance < nearest.distance) nearest = { kind: "wall", distance: hitDistance, end: hit, wallId: wall.id };
  }
  return nearest;
}

function rayCircleDistance(origin: Vec2, direction: Vec2, center: Vec2, radius: number, maxRange = FIRE_RANGE): number | null {
  const toCenter = { x: center.x - origin.x, y: center.y - origin.y };
  const projection = toCenter.x * direction.x + toCenter.y * direction.y;
  if (projection < 0 || projection > maxRange) return null;
  return distance(add(origin, mul(direction, projection)), center) <= radius ? projection : null;
}

function damageWall(room: RoomState, wallId: string, shooterId: PlayerId): void {
  const wall = room.map.walls.find((candidate) => candidate.id === wallId);
  if (!wall || !isShootableDestructibleSegment(wall)) return;
  wall.hp = Math.max(0, (wall.hp ?? wall.maxHp ?? 1) - 1);
  if (wall.hp <= 0) {
    wall.destroyed = true;
    getSlot(room, shooterId).lastSeenWalls.set(wall.id, structuredClone(wall));
    pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: wall.id, playerId: shooterId });
  }
}

function damageCamera(room: RoomState, cameraId: string, shooterId: PlayerId): void {
  const camera = room.deployedCameras.find((candidate) => candidate.id === cameraId);
  if (!camera || camera.destroyed) return;
  camera.hp = 0;
  camera.destroyed = true;
  getSlot(room, shooterId).lastSeenCameras.set(camera.id, structuredClone(camera));
  getSlot(room, camera.owner).lastSeenCameras.set(camera.id, structuredClone(camera));
  pushEvent(room, { type: "camera-destroyed", tick: room.tick, playerId: shooterId, cameraId: camera.id });
}

function damageSoundSensor(room: RoomState, sensorId: string, _shooterId: PlayerId): void {
  const sensor = room.soundSensors.find((candidate) => candidate.id === sensorId);
  if (!sensor || sensor.destroyed) return;
  sensor.hp = 0;
  sensor.destroyed = true;
}

function finishRound(room: RoomState, winner: PlayerId | "draw", reason: "kill" | "timer"): void {
  if (winner !== "draw") room.round.scores[winner] = (room.round.scores[winner] ?? 0) + 1;
  room.round.winner = winner;
  room.round.reason = reason;
  pushEvent(room, { type: "round-end", tick: room.tick, winner, reason });
  if (winner !== "draw" && (room.round.scores[winner] ?? 0) >= 2) {
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
    const player = getPlayer(room, spawn.id);
    const slot = getSlot(room, player.id);
    applyPendingLoadout(player, slot);
    player.position = { ...spawn.position };
    player.velocity = { x: 0, y: 0 };
    player.aim = spawn.angle;
    player.alive = true;
    player.hp = PLAYER_MAX_HP;
    const weapon = createWeapon({ weaponId: player.weaponId });
    player.ammo = weapon.magSize;
    player.magSize = weapon.magSize;
    player.isReloading = false;
    player.walking = false;
    delete player.reloadEndsAtTick;
    player.gadgets = { ...player.gadgetLoadout };
    slot.inputState = { move: { x: 0, y: 0 }, aim: spawn.angle, fire: false, walk: false };
    slot.pendingActions = [];
    slot.seenActionSeqs.clear();
    slot.actionResults = [];
    slot.nextFireTick = room.tick;
    slot.nextActionTick = room.tick;
    slot.lastSeenWalls.clear();
    slot.lastSeenCameras.clear();
  }
}

function applyPendingLoadouts(room: RoomState): void {
  for (const player of Object.values(room.players)) {
    applyPendingLoadout(player, getSlot(room, player.id));
  }
}

function applyPendingLoadout(player: PlayerState, slot: PlayerSlot): void {
  if (!slot.pendingLoadout) return;
  applyPlayerLoadout(player, slot.pendingLoadout);
  refillPlayerResources(player);
  delete slot.pendingLoadout;
}

function refillPlayerResources(player: PlayerState): void {
  const weapon = createWeapon({ weaponId: player.weaponId });
  player.magSize = weapon.magSize;
  player.ammo = weapon.magSize;
  player.isReloading = false;
  delete player.reloadEndsAtTick;
  player.gadgets = { ...player.gadgetLoadout };
}

function resetMatch(room: RoomState): void {
  room.tick = 0;
  room.round = { phase: "countdown", roundNumber: 1, scores: scoresForPlayers(playerIds(room)), startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS };
  room.rematchRequests.clear();
  resetRoundWorld(room);
  resetPlayersForRound(room);
}

export function isExpiredUnfilledLobby(room: RoomState, nowMs = Date.now()): boolean {
  const connected = Object.values(room.slots).filter((slot) => slot.connected).length;
  return room.round.phase === "lobby" && connected < Object.keys(room.slots).length && nowMs - room.createdAtMs >= 60_000;
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
    for (const target of enemyPlayers(room, sensor.owner)) {
      const speed = Math.hypot(target.velocity.x, target.velocity.y);
      const triggered = target.alive && !target.walking && speed >= SOUND_SENSOR_SPEED_THRESHOLD && distance(sensor.position, target.position) <= sensor.radius;
      if (!triggered) continue;
      sensor.triggeredUntilTick = room.tick + SOUND_SENSOR_TRIGGER_TICKS;
      const detection: Detection = {
        id: `${sensor.id}-${target.id}-${room.tick}`,
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
}

function breachNearestWall(room: RoomState, player: PlayerState): boolean {
  const target = room.map.walls
    .filter((wall) => isShootableDestructibleSegment(wall))
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
    for (const target of enemyPlayers(room, sensor.owner)) {
      if (!target.alive) continue;
      const seesTarget = sensor.kind === "camera"
        ? pointInCone(sensor.position, sensor.angle, sensor.fov, sensor.range, target.position) && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position)
        : distance(sensor.position, target.position) <= sensor.range && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position) && room.tick % 20 === 0;
      if (!seesTarget) continue;
      const confidence = sensor.kind === "camera" ? 0.82 : 0.55;
      const noise = sensor.kind === "motion" ? Math.sin(room.tick * 12.9898) * 18 : 0;
      const detection: Detection = { id: `${sensor.id}-${target.id}-${room.tick}`, kind: sensor.kind === "motion" ? "motion-pulse" : "camera", position: { x: target.position.x + noise, y: target.position.y - noise }, confidence, expiresAtTick: room.tick + (sensor.kind === "motion" ? 35 : 8), targetId: target.id };
      room.detections.push(detection);
      pushEvent(room, { type: "sensor-detect", tick: room.tick, sensorId: sensor.id, target: target.id, confidence });
    }
  }
}

export function snapshotFor(room: RoomState, playerId: PlayerId): ServerSnapshot {
  const self = getPlayer(room, playerId);
  const slot = getSlot(room, playerId);
  completeReload(self, room.tick);
  const debug = slot.debug;
  const visiblePlayers = enemyPlayers(room, playerId)
    .filter((opponent) => opponent.alive && isPointVisibleToPlayer(room, self, opponent.position))
    .map((opponent) => ({ ...opponent, position: { ...opponent.position }, velocity: { ...opponent.velocity } }));
  const selfWeapon = createWeapon({ weaponId: self.weaponId });
  const polygon = visibleConePolygonWithSmoke(room.map, room.smokes, self.position, self.aim, selfWeapon.visionFov, selfWeapon.visionRange, 54);
  slot.explored.push(...polygon.filter((_, index) => index % 8 === 0));
  slot.explored = slot.explored.slice(-400);
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
    ...(slot.pendingLoadout ? { nextLoadout: structuredClone(slot.pendingLoadout) } : {}),
    visiblePlayers,
    detections: debug ? room.detections : room.detections.filter((detection) => detection.owner === playerId || isPointVisibleToPlayer(room, self, detection.position)),
    map: { walls: debug ? room.map.walls : wallsForPlayer(room, playerId), sensors: debug ? room.map.sensors : [] },
    gadgets: { cameras: visibleCameras, molotovs: visibleMolotovs, smokes: visibleSmokes, soundSensors: visibleSoundSensors },
    shotImpacts: visibleShotImpacts,
    visiblePolygon: polygon,
    visibleCircles: [
      { position: { ...self.position }, radius: PLAYER_CLOSE_VISION_RADIUS },
      ...room.deployedCameras.filter((camera) => camera.owner === playerId && !camera.destroyed).map((camera) => ({ position: camera.position, radius: camera.radius }))
    ],
    explored: slot.explored,
    actionResults: slot.actionResults.slice(-12)
  };

  if (debug) {
    snapshot.debug = {
      players: Object.values(room.players),
      detections: room.detections,
      visibleByPlayer: {
        ...Object.fromEntries(Object.values(room.players).map((player) => [player.id, visibleConePolygonWithSmoke(room.map, room.smokes, player.position, player.aim, createWeapon({ weaponId: player.weaponId }).visionFov, createWeapon({ weaponId: player.weaponId }).visionRange, 48)]))
      } as Record<PlayerId, Vec2[]>
    };
  }
  return snapshot;
}

function isPointVisibleToPlayer(room: RoomState, player: PlayerState, point: Vec2): boolean {
  if (distance(player.position, point) <= PLAYER_CLOSE_VISION_RADIUS && hasLineOfSightWithSmoke(room.map, room.smokes, player.position, point)) return true;
  const weapon = createWeapon({ weaponId: player.weaponId });
  if (hasConeLineOfSightWithSmoke(room.map, room.smokes, player.position, player.aim, weapon.visionFov, weapon.visionRange, point)) return true;
  return room.deployedCameras.some((camera) => camera.owner === player.id && !camera.destroyed && distance(camera.position, point) <= camera.radius && hasLineOfSightWithSmoke(room.map, room.smokes, camera.position, point));
}

function wallVisibleToPlayer(room: RoomState, player: PlayerState, wall: Wall): boolean {
  const midpoint = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
  return isPointVisibleToPlayer(room, player, wall.a) || isPointVisibleToPlayer(room, player, wall.b) || isPointVisibleToPlayer(room, player, midpoint);
}

function wallsForPlayer(room: RoomState, playerId: PlayerId): Wall[] {
  const player = getPlayer(room, playerId);
  const slot = getSlot(room, playerId);
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
  const player = getPlayer(room, playerId);
  const slot = getSlot(room, playerId);
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
