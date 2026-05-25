import {
  add,
  angleToVector,
  createPlayerClass,
  createWeapon,
  distance,
  distanceToSegment,
  isHingedDoorSegment,
  isShootableDestructibleSegment,
  lineIntersection,
  mapObjectives,
  mul,
  normalize,
  pointInCone,
  sampleMap,
  segmentBlocksMovement,
  segmentBlocksShooting,
  segmentPreset,
  type AuthoritativeEvent,
  type ActionResult,
  type AudibleEvent,
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
  DEBUG_VISION_RAYS,
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
  ENABLE_MATCH_ANALYTICS,
  FIRE_RANGE,
  MAX_ACTION_RESULTS,
  MAX_ANALYTICS_EVENTS,
  MAX_EXPLORED_POINTS,
  MAX_REPLAY_COMMANDS,
  MAX_REPLAY_EVENTS,
  MAX_SOUND_EVENTS,
  MOLOTOV_DAMAGE_INTERVAL,
  MOLOTOV_RANGE,
  MOLOTOV_RADIUS,
  MOLOTOV_TICKS,
  NORMAL_VISION_RAYS,
  PLAYER_CLOSE_VISION_RADIUS,
  PLAYER_WALK_SPEED,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  POST_GADGET_LOCKOUT_TICKS,
  RELOAD_TICKS,
  OBJECTIVE_CAPTURE_TICKS,
  OVERTIME_TICKS,
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
  SOUND_EVENT_TTL_TICKS,
  SOUND_RADIUS_ABILITY,
  SOUND_RADIUS_ASSAULT,
  SOUND_RADIUS_BREACH,
  SOUND_RADIUS_DOOR,
  SOUND_RADIUS_GADGET,
  SOUND_RADIUS_IMPACT,
  SOUND_RADIUS_RELOAD,
  SOUND_RADIUS_ROUND,
  SOUND_RADIUS_RUN_FOOTSTEP,
  SOUND_RADIUS_SHOTGUN,
  SOUND_RADIUS_SNIPER,
  SOUND_RADIUS_WALK_FOOTSTEP,
  RUN_FOOTSTEP_INTERVAL_TICKS,
  TICK_RATE,
  WALK_FOOTSTEP_INTERVAL_TICKS,
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
  | { seq: number; type: "ability" }
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

interface RoomScratch {
  desiredMovements: DesiredMovement[];
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
  nextAbilityTick: number;
  nextFootstepTick: number;
  weaponBloomRadians: number;
  shotsFired: number;
  lastSeenWalls: Map<string, Wall>;
  lastSeenCameras: Map<string, DeployedCamera>;
}

const TACTICAL_PING_RADIUS = 420;
const TACTICAL_PING_TICKS = 90;
const SCOUT_DASH_DISTANCE = 96;
const BREACHER_ABILITY_RANGE = 76;

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
  playerList: PlayerState[];
  slotList: PlayerSlot[];
  activeMovementWalls: Wall[];
  activeVisionWalls: Wall[];
  activeShootingWalls: Wall[];
  activeDoors: Wall[];
  activePlacementBlockers: Wall[];
  scratch: RoomScratch;
  detections: Detection[];
  shotImpacts: ShotImpact[];
  soundEvents: AudibleEvent[];
  nextSoundEventId: number;
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
        abilityId: "tactical-ping",
        abilityName: "Tactical Ping",
        abilityCooldownTicks: createPlayerClass().ability.cooldownTicks,
        abilityReadyAtTick: 0,
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

  const room: RoomState = {
    id,
    map,
    baseMap,
    createdAtMs: Date.now(),
    tick: 0,
    round: { phase: "lobby", roundNumber: 1, scores: scoresForPlayers(playerIds), startsAtTick: ROUND_COUNTDOWN_TICKS, endsAtTick: ROUND_COUNTDOWN_TICKS + ROUND_TICKS },
    players,
    slots,
    playerList: Object.values(players),
    slotList: Object.values(slots),
    activeMovementWalls: [],
    activeVisionWalls: [],
    activeShootingWalls: [],
    activeDoors: [],
    activePlacementBlockers: [],
    scratch: { desiredMovements: [] },
    detections: [],
    shotImpacts: [],
    soundEvents: [],
    nextSoundEventId: 0,
    deployedCameras: [],
    molotovs: [],
    smokes: [],
    soundSensors: [],
    rematchRequests: new Set(),
    replay: { mapId: map.id, mapVersion: map.version, seed: 1, commands: [], events: [] },
    analytics: []
  };
  refreshGeometryCaches(room);
  return room;
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
    nextAbilityTick: 0,
    nextFootstepTick: 0,
    weaponBloomRadians: 0,
    shotsFired: 0,
    lastSeenWalls: new Map(),
    lastSeenCameras: new Map()
  };
}

function playerIds(room: RoomState): PlayerId[] {
  return room.playerList.map((player) => player.id);
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
  return room.playerList.filter((candidate) => candidate.id !== playerId && candidate.team !== player.team);
}

function scoresForPlayers(ids: PlayerId[]): Record<PlayerId, number> {
  return Object.fromEntries(ids.map((id) => [id, 0])) as Record<PlayerId, number>;
}

function applyPlayerLoadout(player: PlayerState, selection?: PlayerLoadoutSelection): void {
  const playerClass = createPlayerClass(selection);
  const weapon = createWeapon(selection);
  player.classId = playerClass.id;
  player.className = playerClass.name;
  player.abilityId = playerClass.ability.id;
  player.abilityName = playerClass.ability.name;
  player.abilityCooldownTicks = playerClass.ability.cooldownTicks;
  player.weaponId = weapon.id;
  player.weaponName = weapon.name;
  player.gadgetLoadout = { ...playerClass.gadgets };
  player.gadgets = { ...playerClass.gadgets };
  player.magSize = weapon.magSize;
  player.ammo = Math.min(player.ammo, weapon.magSize);
}

export function joinRoom(room: RoomState, debug = false, preferred?: PlayerId, loadout?: PlayerLoadoutSelection): ServerWelcome | null {
  const playerId = preferred ?? room.slotList.find((candidate) => !candidate.connected)?.id ?? null;
  if (!playerId || room.round.matchWinner) return null;
  const slot = getSlot(room, playerId);
  applyPlayerLoadout(getPlayer(room, playerId), loadout);
  slot.connected = true;
  slot.debug = debug;
  if (room.slotList.every((candidate) => candidate.connected) && room.round.phase === "lobby") {
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
  pushBounded(room.replay.commands, { ...command, playerId }, MAX_REPLAY_COMMANDS);
}

function enqueueCommandActions(slot: PlayerSlot, command: PlayerCommand): void {
  const actions: PendingAction[] = [];
  if (command.reload) actions.push({ seq: command.seq, type: "reload" });
  if (command.use === "breach" || command.use === "door-toggle") actions.push({ seq: command.seq, type: "use", use: command.use });
  if (command.ability) actions.push({ seq: command.seq, type: "ability" });
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

function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function retainInPlace<T>(items: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < items.length; read += 1) {
    const item = items[read]!;
    if (!keep(item)) continue;
    items[write] = item;
    write += 1;
  }
  items.length = write;
}

function rejectPendingActions(room: RoomState, reason: ActionRejectReason): void {
  for (const slot of room.slotList) {
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
      if (accepted) emitReloadSound(room, player, "start");
      recordActionResult(slot, action.seq, "reload", accepted, accepted ? undefined : "invalid");
      continue;
    }
    if (action.type === "use") {
      const accepted = action.use === "breach" ? breachNearestWall(room, player) : toggleNearestDoor(room, player);
      recordActionResult(slot, action.seq, "use", accepted, accepted ? undefined : "invalid");
      continue;
    }
    if (action.type === "ability") {
      const result = activateClassAbility(room, player, slot);
      recordActionResult(slot, action.seq, "ability", result.accepted, result.accepted ? undefined : result.reason);
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
  pushBounded(slot.actionResults, { seq, action, accepted, ...(reason ? { reason } : {}) }, MAX_ACTION_RESULTS);
}

export function stepRoom(room: RoomState): void {
  room.tick += 1;
  retainInPlace(room.shotImpacts, (impact) => impact.tick >= room.tick - 5);
  retainInPlace(room.soundEvents, (event) => event.tick >= room.tick - SOUND_EVENT_TTL_TICKS);
  if (room.molotovs.length > 0) retainInPlace(room.molotovs, (zone) => zone.expiresAtTick >= room.tick);
  if (room.smokes.length > 0) retainInPlace(room.smokes, (zone) => zone.expiresAtTick >= room.tick);
  if (room.soundSensors.length > 0) retainInPlace(room.soundSensors, (zone) => !zone.destroyed);
  if (room.round.phase === "ended") return;
  if (room.round.phase === "lobby") {
    integrateDoorsIfNeeded(room);
    rejectPendingActions(room, "round-inactive");
    return;
  }
  if (room.round.phase === "countdown" && room.tick >= room.round.startsAtTick) {
    applyPendingLoadouts(room);
    room.round.phase = "active";
    delete room.round.winner;
    delete room.round.reason;
    delete room.round.nextRoundStartsAtTick;
    emitRoundSound(room, "start");
    pushEvent(room, { type: "round-start", tick: room.tick });
  }
  if (!isPlayablePhase(room.round.phase)) {
    integrateDoorsIfNeeded(room);
    rejectPendingActions(room, "round-inactive");
    return;
  }

  const desiredMovements = room.scratch.desiredMovements;
  desiredMovements.length = 0;
  for (const player of room.playerList) {
    if (!player.alive) continue;
    const slot = getSlot(room, player.id);
    const input = slot.inputState;
    if (completeReload(player, room.tick)) emitReloadSound(room, player, "complete");
    player.walking = Boolean(input.walk);
    const speed = player.walking ? PLAYER_WALK_SPEED : playerRunSpeed(player);
    const delta = { x: input.move.x * speed, y: input.move.y * speed };
    const desired = add(player.position, delta);
    collectDoorPushes(room, player.position, desired, delta);
    player.aim = input.aim;
    desiredMovements.push({ player, slot, input, desired });
  }
  integrateDoorsIfNeeded(room);

  for (const { player, slot, input, desired } of desiredMovements) {
    const next = movePlayerWithSweptCollision(room.map, player.position, desired, PLAYER_RADIUS, room.activeMovementWalls);
    player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
    player.position = next;
    emitFootstepSound(room, player, slot);
    processPendingActions(room, player, slot);
    if (input.fire && room.tick >= slot.nextActionTick) resolveShot(room, player.id);
    recoverWeaponBloom(player, slot);
    if (ENABLE_MATCH_ANALYTICS) pushBounded(room.analytics, { type: "movement-sample", tick: room.tick, data: { playerId: player.id, position: player.position } }, MAX_ANALYTICS_EVENTS);
  }
  resolvePlayerDoorOverlaps(room);

  if (room.map.sensors.length > 0) resolveSensors(room);
  if (room.soundSensors.length > 0) resolveSoundSensors(room);
  if (room.molotovs.length > 0) resolveMolotovDamage(room);
  if (room.round.phase === "overtime" && room.round.objective) resolveObjectiveCapture(room);
  if (room.detections.length > 0) retainInPlace(room.detections, (detection) => detection.expiresAtTick >= room.tick);
  if (room.round.phase === "active" && room.tick >= room.round.endsAtTick) enterOvertimeOrDraw(room);
  if (room.round.phase === "overtime" && (room.round.overtimeEndsAtTick ?? 0) <= room.tick) finishRound(room, "draw", "timer");
}

function playerRunSpeed(player: PlayerState): number {
  return createWeapon({ weaponId: player.weaponId }).moveSpeed / TICK_RATE;
}

function recoverWeaponBloom(player: PlayerState, slot: PlayerSlot): void {
  if (slot.weaponBloomRadians <= 0) return;
  const weapon = createWeapon({ weaponId: player.weaponId });
  slot.weaponBloomRadians = Math.max(0, slot.weaponBloomRadians - weapon.bloomRecoveryRadiansPerTick);
}

function emitFootstepSound(room: RoomState, player: PlayerState, slot: PlayerSlot): void {
  const speed = Math.hypot(player.velocity.x, player.velocity.y);
  if (speed < 0.35 || room.tick < slot.nextFootstepTick) return;
  const walking = Boolean(player.walking);
  slot.nextFootstepTick = room.tick + (walking ? WALK_FOOTSTEP_INTERVAL_TICKS : RUN_FOOTSTEP_INTERVAL_TICKS);
  emitSound(room, {
    kind: "footstep",
    sourceId: player.id,
    position: player.position,
    radius: walking ? SOUND_RADIUS_WALK_FOOTSTEP : SOUND_RADIUS_RUN_FOOTSTEP,
    volume: walking ? 0.28 : 0.62,
    subtype: walking ? "walk" : "run"
  });
}

function emitReloadSound(room: RoomState, player: PlayerState, subtype: "start" | "complete"): void {
  emitSound(room, {
    kind: "reload",
    sourceId: player.id,
    position: player.position,
    radius: SOUND_RADIUS_RELOAD,
    volume: subtype === "start" ? 0.5 : 0.38,
    subtype,
    weaponId: player.weaponId
  });
}

function emitDoorSound(room: RoomState, door: Wall, subtype: string): void {
  emitSound(room, {
    kind: "door",
    sourceId: door.id,
    position: segmentMidpoint(door),
    radius: SOUND_RADIUS_DOOR,
    volume: subtype.includes("shot") ? 0.78 : 0.48,
    subtype
  });
}

function emitRoundSound(room: RoomState, subtype: string): void {
  emitSound(room, {
    kind: "round",
    sourceId: room.id,
    position: { x: room.map.bounds.width / 2, y: room.map.bounds.height / 2 },
    radius: SOUND_RADIUS_ROUND,
    volume: subtype === "start" ? 0.62 : 0.78,
    subtype
  });
}

function segmentMidpoint(wall: Wall): Vec2 {
  return { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
}

function isPlayablePhase(phase: ServerSnapshot["round"]["phase"]): boolean {
  return phase === "active" || phase === "overtime";
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
  if (!wall.destructible) {
    const { hp: _hp, maxHp: _maxHp, ...runtimeWall } = wall;
    return runtimeWall;
  }
  const preset = segmentPreset(wall);
  const maxHp = wall.maxHp ?? (preset === "mesh" || preset === "window" ? 1 : 5);
  return { ...wall, maxHp, hp: wall.hp ?? maxHp };
}

export function refreshGeometryCaches(room: RoomState): void {
  room.activeMovementWalls = room.map.walls.filter(segmentBlocksMovement);
  room.activeVisionWalls = room.map.walls.filter((wall) => !wall.destroyed && wall.blocksVision);
  room.activeShootingWalls = room.map.walls.filter((wall) => !wall.destroyed && (segmentBlocksShooting(wall) || isShootableDestructibleSegment(wall)));
  room.activeDoors = room.map.walls.filter((wall) => isHingedDoorSegment(wall) && !wall.destroyed);
  room.activePlacementBlockers = room.map.walls.filter((wall) => !wall.destroyed && (isHingedDoorSegment(wall) || wall.blocksShooting || wall.blocksVision));
}

function collectDoorPushes(room: RoomState, current: Vec2, desired: Vec2, delta: Vec2): void {
  const moveDistance = Math.hypot(delta.x, delta.y);
  if (moveDistance < 0.01) return;
  for (const door of room.activeDoors) {
    if (!door.hinge) continue;
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
    if (room.tick % 18 === 0) emitDoorSound(room, door, "push");
  }
}

function movePlayerWithSweptCollision(map: MapDefinition, current: Vec2, desired: Vec2, radius: number, movementWalls = map.walls): Vec2 {
  const totalDistance = distance(current, desired);
  const steps = Math.max(1, Math.ceil(totalDistance / Math.max(1, radius * 0.3)));
  let position = current;
  for (let step = 1; step <= steps; step += 1) {
    const target = {
      x: current.x + ((desired.x - current.x) * step) / steps,
      y: current.y + ((desired.y - current.y) * step) / steps
    };
    const next = moveWithCapsuleCollision(map, position, target, radius, movementWalls);
    if (next === position) return position;
    position = next;
  }
  return position;
}

function moveWithCapsuleCollision(map: MapDefinition, current: Vec2, desired: Vec2, radius: number, movementWalls = map.walls): Vec2 {
  let resolved = {
    x: Math.max(radius, Math.min(map.bounds.width - radius, desired.x)),
    y: Math.max(radius, Math.min(map.bounds.height - radius, desired.y))
  };
  for (const wall of movementWalls) {
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

function integrateDoorsIfNeeded(room: RoomState): void {
  if (!room.activeDoors.some((door) => doorNeedsIntegration(room, door))) return;
  integrateDoors(room);
}

function doorNeedsIntegration(room: RoomState, door: Wall): boolean {
  return Boolean(door.targetAngle !== undefined || Math.abs(door.angularVelocity ?? 0) > 0.0005 || room.tick - (door.lastPushTick ?? -9999) <= 2);
}

function integrateDoors(room: RoomState): void {
  for (const door of room.activeDoors) {
    if (!door.hinge || !door.closedB) continue;
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
  for (const player of room.playerList) {
    if (!player.alive) continue;
    let position = player.position;
    for (const door of room.activeDoors) {
      if (!segmentBlocksMovement(door)) continue;
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
  return room.activeMovementWalls.some((wall) => {
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
  return room.playerList.some((player) => {
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

function completeReload(player: PlayerState, tick: number): boolean {
  if (!player.isReloading || player.reloadEndsAtTick === undefined || tick < player.reloadEndsAtTick) return false;
  player.ammo = player.magSize;
  player.isReloading = false;
  delete player.reloadEndsAtTick;
  return true;
}

function startReload(player: PlayerState, tick: number): boolean {
  if (player.isReloading || player.ammo >= player.magSize) return false;
  player.isReloading = true;
  player.reloadEndsAtTick = tick + RELOAD_TICKS;
  return true;
}

function toggleNearestDoor(room: RoomState, player: PlayerState): boolean {
  const door = room.activeDoors
    .filter((candidate) => candidate.hinge && candidate.closedB)
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
    emitDoorSound(room, door, "toggle-close");
    return true;
  }

  const hinge = door.hinge;
  const panel = { x: door.b.x - hinge.x, y: door.b.y - hinge.y };
  const playerOffset = { x: player.position.x - hinge.x, y: player.position.y - hinge.y };
  const side = cross(panel, playerOffset);
  const sign = Math.abs(side) > 0.001 ? -Math.sign(side) : Math.sign(Math.cos(player.aim)) || 1;
  door.targetAngle = sign * DOOR_MAX_ANGLE;
  emitDoorSound(room, door, "toggle-open");
  return true;
}

function activateClassAbility(room: RoomState, player: PlayerState, slot: PlayerSlot): DeployResult {
  if (!player.alive) return { accepted: false, reason: "round-inactive" };
  if (room.tick < slot.nextAbilityTick) return { accepted: false, reason: "action-lockout" };

  const accepted = runClassAbility(room, player, slot);
  if (!accepted) return { accepted: false, reason: "invalid" };

  slot.nextAbilityTick = room.tick + player.abilityCooldownTicks;
  player.abilityReadyAtTick = slot.nextAbilityTick;
  emitSound(room, {
    kind: "ability",
    sourceId: player.id,
    position: player.position,
    radius: player.abilityId === "breach-any" ? SOUND_RADIUS_BREACH : SOUND_RADIUS_ABILITY,
    volume: player.abilityId === "dash" ? 0.58 : 0.72,
    subtype: player.abilityId,
    abilityId: player.abilityId
  });
  return { accepted: true };
}

function runClassAbility(room: RoomState, player: PlayerState, slot: PlayerSlot): boolean {
  if (player.abilityId === "tactical-ping") {
    tacticalPing(room, player);
    return true;
  }
  if (player.abilityId === "dash") {
    scoutDash(room, player, slot);
    return true;
  }
  if (player.abilityId === "breach-any") return breachAnyWall(room, player);
  return false;
}

function tacticalPing(room: RoomState, player: PlayerState): void {
  for (const target of enemyPlayers(room, player.id)) {
    if (!target.alive || distance(player.position, target.position) > TACTICAL_PING_RADIUS) continue;
    const detection: Detection = {
      id: `${player.id}-ping-${target.id}-${room.tick}`,
      kind: "tactical-ping",
      position: { ...target.position },
      radius: 28,
      confidence: 0.78,
      expiresAtTick: room.tick + TACTICAL_PING_TICKS,
      owner: player.id,
      targetId: target.id
    };
    room.detections.push(detection);
    pushEvent(room, { type: "sensor-detect", tick: room.tick, sensorId: "tactical-ping", target: target.id, confidence: detection.confidence });
  }
}

function scoutDash(room: RoomState, player: PlayerState, slot: PlayerSlot): void {
  const move = slot.inputState.move;
  const moveLength = Math.hypot(move.x, move.y);
  const direction = moveLength > 0.01 ? normalize(move) : angleToVector(player.aim);
  const desired = add(player.position, mul(direction, SCOUT_DASH_DISTANCE));
    const next = movePlayerWithSweptCollision(room.map, player.position, desired, PLAYER_RADIUS, room.activeMovementWalls);
  player.velocity = { x: next.x - player.position.x, y: next.y - player.position.y };
  player.position = next;
}

function breachAnyWall(room: RoomState, player: PlayerState): boolean {
  const target = room.map.walls
    .filter((wall) => !wall.destroyed && !isHingedDoorSegment(wall) && !isLevelBoundarySegment(room.map, wall) && (wall.blocksMovement || wall.blocksVision || wall.blocksShooting))
    .map((wall) => ({ wall, distance: distanceToSegment(player.position, wall.a, wall.b) }))
    .filter(({ distance: wallDistance }) => wallDistance <= BREACHER_ABILITY_RANGE)
    .sort((a, b) => a.distance - b.distance)[0]?.wall;
  if (!target) return false;
  destroyWallSegment(room, target, player.id);
  return true;
}

function isLevelBoundarySegment(map: MapDefinition, wall: Wall): boolean {
  const tolerance = Math.max(12, wall.thickness);
  const idLooksBoundary = /^(north|south|east|west|boundary|bounds?)(-|$)/i.test(wall.id);
  const onWest = wall.a.x <= tolerance && wall.b.x <= tolerance;
  const onEast = wall.a.x >= map.bounds.width - tolerance && wall.b.x >= map.bounds.width - tolerance;
  const onNorth = wall.a.y <= tolerance && wall.b.y <= tolerance;
  const onSouth = wall.a.y >= map.bounds.height - tolerance && wall.b.y >= map.bounds.height - tolerance;
  return Boolean(idLooksBoundary || onWest || onEast || onNorth || onSouth);
}

function destroyWallSegment(room: RoomState, wall: Wall, playerId: PlayerId): void {
  wall.hp = 0;
  wall.destroyed = true;
  getSlot(room, playerId).lastSeenWalls.set(wall.id, cloneWall(wall));
  emitSound(room, {
    kind: "impact",
    sourceId: wall.id,
    position: segmentMidpoint(wall),
    radius: isHingedDoorSegment(wall) ? SOUND_RADIUS_DOOR * 1.7 : SOUND_RADIUS_BREACH,
    volume: isHingedDoorSegment(wall) ? 0.82 : 0.74,
    subtype: isHingedDoorSegment(wall) ? "door-break" : "destroy"
  });
  pushEvent(room, { type: "wall-destroyed", tick: room.tick, wallId: wall.id, playerId });
  refreshGeometryCaches(room);
}

const gadgetStrategies: Record<GadgetKind, GadgetStrategy> = {
  camera: {
    kind: "camera",
    range: CAMERA_RANGE,
    canDeploy: basicDeployCheck("camera", CAMERA_RANGE, 7),
    deploy(room, player, _action, resolved) {
      const camera: DeployedCamera = { id: `${player.id}-cam-${room.tick}-${room.deployedCameras.length}`, owner: player.id, position: resolved.position, radius: CAMERA_RADIUS, hp: 1 };
      room.deployedCameras.push(camera);
      getSlot(room, player.id).lastSeenCameras.set(camera.id, cloneCamera(camera));
      pushEvent(room, { type: "camera-deployed", tick: room.tick, playerId: player.id, cameraId: camera.id });
      emitGadgetSound(room, player, "camera", resolved.position);
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
      emitGadgetSound(room, player, "molotov", resolved.position);
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
      emitGadgetSound(room, player, "smoke", resolved.position);
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
      refreshGeometryCaches(room);
      getSlot(room, player.id).lastSeenWalls.set(wall.id, cloneWall(wall));
      pushEvent(room, { type: "deployable-wall-deployed", tick: room.tick, playerId: player.id, wallId: wall.id });
      emitGadgetSound(room, player, "wall", resolved.position);
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
      emitGadgetSound(room, player, "sound", resolved.position);
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

function emitGadgetSound(room: RoomState, player: PlayerState, gadget: GadgetKind, position: Vec2): void {
  const loud = gadget === "molotov" || gadget === "smoke" || gadget === "wall";
  emitSound(room, {
    kind: "gadget",
    sourceId: player.id,
    position,
    radius: loud ? SOUND_RADIUS_GADGET : SOUND_RADIUS_GADGET * 0.72,
    volume: loud ? 0.68 : 0.44,
    subtype: gadget,
    gadget
  });
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
    if (startReload(shooter, room.tick)) emitReloadSound(room, shooter, "start");
    return;
  }
  shooter.ammo -= 1;
  slot.nextFireTick = room.tick + weapon.fireCooldownTicks;
  const origin = { ...shooter.position };
  emitSound(room, {
    kind: "gunshot",
    sourceId: shooterId,
    position: origin,
    radius: weaponSoundRadius(shooter.weaponId),
    volume: shooter.weaponId === "sniper" ? 1 : shooter.weaponId === "shotgun" ? 0.86 : 0.72,
    subtype: shooter.weaponId,
    weaponId: shooter.weaponId
  });
  const shotRange = Number.isFinite(weapon.effectiveRange) ? weapon.effectiveRange : maxMapShotRange(room.map);
  const hits: Array<ReturnType<typeof resolveHitscan>> = [];
  const shotIndex = slot.shotsFired;
  const currentSpread = weapon.spreadRadians + slot.weaponBloomRadians;
  for (const angle of shotAngles(shooter.aim, weapon.pelletCount, currentSpread, room.replay.seed + room.tick, shotIndex, shooterId)) {
    const rayEnd = add(origin, mul(angleToVector(angle), shotRange));
    const hit = resolveHitscan(room, shooterId, origin, rayEnd, shotRange);
    hits.push(hit);
    const impact: ShotImpact = { id: `${shooterId}-${room.tick}-${room.shotImpacts.length}`, tick: room.tick, shooter: shooterId, origin, end: hit.end, hit: hit.kind, ...(hit.targetId ? { targetId: hit.targetId } : {}), ...(hit.wallId ? { wallId: hit.wallId } : {}), ...(hit.cameraId ? { cameraId: hit.cameraId } : {}), ...(hit.soundSensorId ? { soundSensorId: hit.soundSensorId } : {}) };
    room.shotImpacts.push(impact);
    pushEvent(room, { type: "shot", tick: room.tick, impact });
  }
  slot.shotsFired += 1;
  slot.weaponBloomRadians = Math.min(weapon.maxBloomRadians, slot.weaponBloomRadians + weapon.bloomPerShotRadians);
  for (const hit of hits) {
    if (hit.kind === "player" && hit.targetId) {
      const target = getPlayer(room, hit.targetId);
      if (!target.alive) continue;
      target.hp = Math.max(0, target.hp - weapon.damage);
      emitDamageSound(room, target, target.hp <= 0 ? "kill" : "hit");
      pushEvent(room, { type: "hit", tick: room.tick, shooter: shooterId, target: hit.targetId });
      if (target.hp <= 0) {
        target.alive = false;
        pushEvent(room, { type: "kill", tick: room.tick, shooter: shooterId, target: hit.targetId });
        finishRound(room, shooterId, "kill");
        return;
      }
    } else if (hit.kind === "wall" && hit.wallId) {
      emitImpactSound(room, hit.end, "wall");
      applyDoorShotImpulse(room, hit.wallId, origin, hit.end, weapon.damage);
      damageWall(room, hit.wallId, shooterId);
    } else if (hit.kind === "camera" && hit.cameraId) {
      emitImpactSound(room, hit.end, "camera");
      damageCamera(room, hit.cameraId, shooterId);
    } else if (hit.kind === "sound-sensor" && hit.soundSensorId) {
      emitImpactSound(room, hit.end, "sound-sensor");
      damageSoundSensor(room, hit.soundSensorId, shooterId);
    }
  }
}

function weaponSoundRadius(weaponId: PlayerState["weaponId"]): number {
  if (weaponId === "sniper") return SOUND_RADIUS_SNIPER;
  if (weaponId === "shotgun") return SOUND_RADIUS_SHOTGUN;
  return SOUND_RADIUS_ASSAULT;
}

function emitImpactSound(room: RoomState, position: Vec2, subtype: string): void {
  emitSound(room, {
    kind: "impact",
    sourceId: subtype,
    position,
    radius: SOUND_RADIUS_IMPACT,
    volume: 0.4,
    subtype
  });
}

function emitDamageSound(room: RoomState, player: PlayerState, subtype: "hit" | "kill"): void {
  emitSound(room, {
    kind: "damage",
    sourceId: player.id,
    position: player.position,
    radius: subtype === "kill" ? SOUND_RADIUS_IMPACT * 1.4 : SOUND_RADIUS_IMPACT,
    volume: subtype === "kill" ? 0.72 : 0.46,
    subtype
  });
}

function maxMapShotRange(map: MapDefinition): number {
  return Math.hypot(map.bounds.width, map.bounds.height) * 2;
}

function applyDoorShotImpulse(room: RoomState, wallId: string, origin: Vec2, impact: Vec2, shotPower: number): boolean {
  const door = room.map.walls.find((candidate) => candidate.id === wallId);
  if (!door || !isHingedDoorSegment(door) || !door.hinge || door.destroyed) return false;
  const shotDirection = normalize({ x: impact.x - origin.x, y: impact.y - origin.y });
  const hingeToImpact = { x: impact.x - door.hinge.x, y: impact.y - door.hinge.y };
  const torque = cross(hingeToImpact, shotDirection);
  if (Math.abs(torque) < 0.001) return false;
  const panelLength = Math.max(1, distance(door.hinge, door.b));
  const lever = Math.max(0.25, Math.min(1, distance(door.hinge, impact) / panelLength));
  const hitScale = Math.max(0, Math.min(1, shotPower / 5));
  const sign = Math.sign(torque);
  const impulseScale = 3;
  const impulse = sign * DOOR_MAX_ANGULAR_SPEED * impulseScale * lever * hitScale;
  const newVelocity = (door.angularVelocity ?? 0) + impulse;
  door.angularVelocity = Math.max(-DOOR_MAX_ANGULAR_SPEED * impulseScale, Math.min(DOOR_MAX_ANGULAR_SPEED * impulseScale, newVelocity));
  const baseTarget = door.targetAngle ?? door.currentAngle ?? 0;
  door.targetAngle = Math.max(-DOOR_MAX_ANGLE, Math.min(DOOR_MAX_ANGLE, baseTarget + sign * DOOR_MAX_ANGLE * hitScale));
  door.lastPushTick = room.tick;
  emitDoorSound(room, door, "shot-impulse");
  return true;
}

function shotAngles(aim: number, pelletCount: number, spreadRadians: number, seed: number, shotIndex: number, shooterId: PlayerId): number[] {
  if (spreadRadians <= 0) return [aim];
  if (pelletCount <= 1) return [aim + deterministicSpreadOffset(seed, shotIndex, 0, shooterId, spreadRadians)];
  const step = spreadRadians / (pelletCount - 1);
  const start = aim - spreadRadians / 2;
  return Array.from({ length: pelletCount }, (_, index) => start + index * step);
}

function deterministicSpreadOffset(seed: number, shotIndex: number, pelletIndex: number, shooterId: PlayerId, spreadRadians: number): number {
  const playerSeed = Number(shooterId.slice(1)) || 1;
  const value = Math.sin(seed * 12.9898 + shotIndex * 78.233 + pelletIndex * 37.719 + playerSeed * 19.19) * 43758.5453;
  const unit = value - Math.floor(value);
  return (unit * 2 - 1) * (spreadRadians / 2);
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

  for (const wall of room.activeShootingWalls) {
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
    destroyWallSegment(room, wall, shooterId);
  }
}

function damageCamera(room: RoomState, cameraId: string, shooterId: PlayerId): void {
  const camera = room.deployedCameras.find((candidate) => candidate.id === cameraId);
  if (!camera || camera.destroyed) return;
  camera.hp = 0;
  camera.destroyed = true;
  emitImpactSound(room, camera.position, "camera-destroyed");
  getSlot(room, shooterId).lastSeenCameras.set(camera.id, cloneCamera(camera));
  getSlot(room, camera.owner).lastSeenCameras.set(camera.id, cloneCamera(camera));
  pushEvent(room, { type: "camera-destroyed", tick: room.tick, playerId: shooterId, cameraId: camera.id });
}

function damageSoundSensor(room: RoomState, sensorId: string, _shooterId: PlayerId): void {
  const sensor = room.soundSensors.find((candidate) => candidate.id === sensorId);
  if (!sensor || sensor.destroyed) return;
  sensor.hp = 0;
  sensor.destroyed = true;
  emitImpactSound(room, sensor.position, "sound-sensor-destroyed");
}

function enterOvertimeOrDraw(room: RoomState): void {
  const objective = chooseOvertimeObjective(room);
  if (!objective) {
    finishRound(room, "draw", "timer");
    return;
  }
  room.round.phase = "overtime";
  room.round.overtimeEndsAtTick = room.tick + OVERTIME_TICKS;
  room.round.objective = {
    id: objective.id,
    position: { ...objective.position },
    radius: objective.radius,
    progressTicks: 0,
    requiredTicks: OBJECTIVE_CAPTURE_TICKS
  };
  emitRoundSound(room, "overtime");
}

function chooseOvertimeObjective(room: RoomState): ReturnType<typeof mapObjectives>[number] | undefined {
  const objectives = mapObjectives(room.map);
  if (objectives.length === 0) return undefined;
  const seed = room.replay.seed + room.round.roundNumber * 997 + room.tick * 31;
  const index = Math.abs(Math.floor(Math.sin(seed) * 10000)) % objectives.length;
  return objectives[index];
}

function resolveObjectiveCapture(room: RoomState): void {
  if (room.round.phase !== "overtime" || !room.round.objective) return;
  const objective = room.round.objective;
  const inside = room.playerList.filter((player) => player.alive && distance(player.position, objective.position) <= objective.radius);
  if (inside.length === 0) {
    delete objective.owner;
    objective.progressTicks = 0;
    return;
  }
  const teams = new Set(inside.map((player) => player.team));
  if (teams.size > 1) {
    delete objective.owner;
    objective.progressTicks = 0;
    return;
  }
  const owner = inside[0]!.id;
  if (objective.owner !== owner) {
    objective.owner = owner;
    objective.progressTicks = 0;
  }
  objective.progressTicks += 1;
  if (objective.progressTicks >= objective.requiredTicks) finishRound(room, owner, "objective");
}

function finishRound(room: RoomState, winner: PlayerId | "draw", reason: "kill" | "timer" | "objective"): void {
  if (winner !== "draw") room.round.scores[winner] = (room.round.scores[winner] ?? 0) + 1;
  room.round.winner = winner;
  room.round.reason = reason;
  delete room.round.objective;
  delete room.round.overtimeEndsAtTick;
  emitRoundSound(room, reason);
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
  refreshGeometryCaches(room);
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
    player.abilityReadyAtTick = room.tick;
    slot.inputState = { move: { x: 0, y: 0 }, aim: spawn.angle, fire: false, walk: false };
    slot.pendingActions = [];
    slot.seenActionSeqs.clear();
    slot.actionResults = [];
    slot.nextFireTick = room.tick;
    slot.nextActionTick = room.tick;
    slot.nextAbilityTick = room.tick;
    slot.nextFootstepTick = room.tick;
    slot.weaponBloomRadians = 0;
    slot.shotsFired = 0;
    slot.lastSeenWalls.clear();
    slot.lastSeenCameras.clear();
  }
}

function applyPendingLoadouts(room: RoomState): void {
  for (const player of room.playerList) {
    applyPendingLoadout(player, getSlot(room, player.id));
  }
}

function applyPendingLoadout(player: PlayerState, slot: PlayerSlot): void {
  if (!slot.pendingLoadout) return;
  applyPlayerLoadout(player, slot.pendingLoadout);
  refillPlayerResources(player);
  slot.weaponBloomRadians = 0;
  slot.shotsFired = 0;
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
  const connected = room.slotList.filter((slot) => slot.connected).length;
  return room.round.phase === "lobby" && connected < Object.keys(room.slots).length && nowMs - room.createdAtMs >= 60_000;
}

function resolveMolotovDamage(room: RoomState): void {
  for (const zone of room.molotovs) {
    const age = room.tick - zone.createdAtTick;
    if (age <= 0 || age % MOLOTOV_DAMAGE_INTERVAL !== 0) continue;
    for (const player of room.playerList) {
      if (!player.alive || distance(player.position, zone.position) > zone.radius) continue;
      if (!hasLineOfSightWithSmoke(room.map, [], zone.position, player.position, room.activeVisionWalls)) continue;
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
  destroyWallSegment(room, target, player.id);
  return true;
}

function resolveSensors(room: RoomState): void {
  for (const sensor of room.map.sensors) {
    if (sensor.destroyed || sensor.corrupted) continue;
    for (const target of enemyPlayers(room, sensor.owner)) {
      if (!target.alive) continue;
      const seesTarget = sensor.kind === "camera"
        ? pointInCone(sensor.position, sensor.angle, sensor.fov, sensor.range, target.position) && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position, room.activeVisionWalls)
        : distance(sensor.position, target.position) <= sensor.range && hasLineOfSightWithSmoke(room.map, room.smokes, sensor.position, target.position, room.activeVisionWalls) && room.tick % 20 === 0;
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
    .map(clonePlayerState);
  const selfWeapon = createWeapon({ weaponId: self.weaponId });
  const polygon = visibleConePolygonWithSmoke(room.map, room.smokes, self.position, self.aim, selfWeapon.visionFov, selfWeapon.visionRange, NORMAL_VISION_RAYS, room.activeVisionWalls);
  slot.explored.push(...polygon.filter((_, index) => index % 8 === 0));
  if (slot.explored.length > MAX_EXPLORED_POINTS) slot.explored.splice(0, slot.explored.length - MAX_EXPLORED_POINTS);
  const visibleShotImpacts = room.shotImpacts.filter((impact) => {
    if (impact.shooter === playerId) return true;
    return isPointVisibleToPlayer(room, self, impact.origin) || isPointVisibleToPlayer(room, self, impact.end);
  });
  const visibleCameras = visibleCamerasFor(room, playerId);
  const visibleMolotovs = room.molotovs.filter((zone) => zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position));
  const visibleSmokes = room.smokes.filter((zone) => zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position));
  const visibleSoundSensors = room.soundSensors.filter((zone) => !zone.destroyed && (zone.owner === playerId || isPointVisibleToPlayer(room, self, zone.position)));
  const audibleEvents = room.soundEvents.filter((event) => distance(self.position, event.position) <= event.radius).map(cloneAudibleEvent);

  const snapshot: ServerSnapshot = {
    type: "snapshot",
    tick: room.tick,
    playerId,
    round: { ...room.round, scores: { ...room.round.scores } },
    self: clonePlayerState(self),
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
    actionResults: slot.actionResults.slice(-12),
    audibleEvents
  };

  if (debug) {
    snapshot.debug = {
      players: room.playerList,
      detections: room.detections,
      visibleByPlayer: {
        ...Object.fromEntries(room.playerList.map((player) => {
          const weapon = createWeapon({ weaponId: player.weaponId });
          return [player.id, visibleConePolygonWithSmoke(room.map, room.smokes, player.position, player.aim, weapon.visionFov, weapon.visionRange, DEBUG_VISION_RAYS, room.activeVisionWalls)];
        }))
      } as Record<PlayerId, Vec2[]>
    };
  }
  return snapshot;
}

function isPointVisibleToPlayer(room: RoomState, player: PlayerState, point: Vec2): boolean {
  if (distance(player.position, point) <= PLAYER_CLOSE_VISION_RADIUS && hasLineOfSightWithSmoke(room.map, room.smokes, player.position, point, room.activeVisionWalls)) return true;
  const weapon = createWeapon({ weaponId: player.weaponId });
  if (hasConeLineOfSightWithSmoke(room.map, room.smokes, player.position, player.aim, weapon.visionFov, weapon.visionRange, point, room.activeVisionWalls)) return true;
  return room.deployedCameras.some((camera) => camera.owner === player.id && !camera.destroyed && distance(camera.position, point) <= camera.radius && hasLineOfSightWithSmoke(room.map, room.smokes, camera.position, point, room.activeVisionWalls));
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
      const clone = cloneWall(wall);
      slot.lastSeenWalls.set(wall.id, clone);
      return [clone];
    }
    const lastSeen = slot.lastSeenWalls.get(wall.id);
    if (lastSeen) return [cloneWall(lastSeen)];
    const authored = room.baseMap.walls.find((candidate) => candidate.id === wall.id);
    return authored ? [cloneWall(authored)] : [];
  });
}

function visibleCamerasFor(room: RoomState, playerId: PlayerId): DeployedCamera[] {
  const player = getPlayer(room, playerId);
  const slot = getSlot(room, playerId);
  const visible: DeployedCamera[] = [];
  for (const camera of room.deployedCameras) {
    if (camera.owner === playerId || isPointVisibleToPlayer(room, player, camera.position)) {
      const clone = cloneCamera(camera);
      slot.lastSeenCameras.set(camera.id, clone);
      visible.push(clone);
      continue;
    }
    const lastSeen = slot.lastSeenCameras.get(camera.id);
    if (lastSeen) visible.push(cloneCamera(lastSeen));
  }
  return visible;
}

function pushEvent(room: RoomState, event: AuthoritativeEvent): void {
  pushBounded(room.replay.events, event, MAX_REPLAY_EVENTS);
}

function emitSound(room: RoomState, event: Omit<AudibleEvent, "id" | "tick">): void {
  pushBounded(
    room.soundEvents,
    {
      id: `sound-${room.id}-${room.nextSoundEventId++}`,
      tick: room.tick,
      ...event,
      position: { ...event.position }
    },
    MAX_SOUND_EVENTS
  );
}

function clonePlayerState(player: PlayerState): PlayerState {
  return { ...player, position: { ...player.position }, velocity: { ...player.velocity }, gadgets: { ...player.gadgets }, gadgetLoadout: { ...player.gadgetLoadout } };
}

function cloneWall(wall: Wall): Wall {
  return {
    ...wall,
    a: { ...wall.a },
    b: { ...wall.b },
    ...(wall.hinge ? { hinge: { ...wall.hinge } } : {}),
    ...(wall.closedA ? { closedA: { ...wall.closedA } } : {}),
    ...(wall.closedB ? { closedB: { ...wall.closedB } } : {})
  };
}

function cloneCamera(camera: DeployedCamera): DeployedCamera {
  return { ...camera, position: { ...camera.position } };
}

function cloneAudibleEvent(event: AudibleEvent): AudibleEvent {
  return { ...event, position: { ...event.position } };
}
