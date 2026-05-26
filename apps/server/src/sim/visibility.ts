import {
  add,
  angleToVector,
  distance,
  hasLineOfSight,
  lineIntersection,
  mul,
  normalizeAngle,
  pointInCone,
  type MapDefinition,
  type SmokeZone,
  type Vec2,
  type Wall
} from "@tac/shared";

export function smokeBlocksSegment(smokes: SmokeZone[], from: Vec2, to: Vec2): boolean {
  return smokes.some((smoke) => smoke.expiresAtTick >= 0 && segmentCircleDistance(from, to, smoke.position) <= smoke.radius);
}

export function hasLineOfSightWithSmoke(map: MapDefinition, smokes: SmokeZone[], from: Vec2, to: Vec2, visionWalls = map.walls): boolean {
  return !smokeBlocksSegment(smokes, from, to) && hasLineOfSightAgainstWalls(map, from, to, visionWalls);
}

export function hasConeLineOfSightWithSmoke(
  map: MapDefinition,
  smokes: SmokeZone[],
  origin: Vec2,
  angle: number,
  fov: number,
  range: number,
  point: Vec2,
  visionWalls?: Wall[]
): boolean {
  return pointInCone(origin, angle, fov, range, point) && hasLineOfSightWithSmoke(map, smokes, origin, point, visionWalls);
}

export function visibleConePolygonWithSmoke(map: MapDefinition, smokes: SmokeZone[], origin: Vec2, angle: number, fov: number, range: number, rays = 48, visionWalls = map.walls): Vec2[] {
  const points: Vec2[] = [origin];
  const start = angle - fov / 2;
  const steps = Math.max(2, rays);
  const angles = new Map<number, number>();
  const addAngle = (rayAngle: number) => {
    if (!angleInCone(rayAngle, angle, fov)) return;
    const offset = angleOffsetFromStart(rayAngle, start);
    angles.set(Math.round(offset * 100000), rayAngle);
  };
  for (let index = 0; index <= steps; index += 1) addAngle(start + (fov * index) / steps);
  for (const wall of visionWalls) {
    addEndpointAngles(origin, angle, fov, range, wall.a, addAngle);
    addEndpointAngles(origin, angle, fov, range, wall.b, addAngle);
  }
  for (const smoke of smokes) addSmokeTangentAngles(origin, angle, fov, range, smoke, addAngle);
  const sortedAngles = [...angles.values()].sort((a, b) => angleOffsetFromStart(a, start) - angleOffsetFromStart(b, start));
  for (const rayAngle of sortedAngles) points.push(raycastWithSmoke(map, smokes, origin, rayAngle, range, visionWalls));
  return points;
}

function addEndpointAngles(origin: Vec2, coneAngle: number, fov: number, range: number, point: Vec2, addAngle: (angle: number) => void): void {
  const pointDistance = distance(origin, point);
  if (pointDistance > range + 4 || pointDistance < 0.001) return;
  const base = Math.atan2(point.y - origin.y, point.x - origin.x);
  const epsilon = Math.max(0.0015, Math.min(0.012, 1 / Math.max(70, pointDistance)));
  for (const candidate of [base - epsilon, base, base + epsilon]) {
    if (angleInCone(candidate, coneAngle, fov)) addAngle(candidate);
  }
}

function addSmokeTangentAngles(origin: Vec2, coneAngle: number, fov: number, range: number, smoke: SmokeZone, addAngle: (angle: number) => void): void {
  const centerDistance = distance(origin, smoke.position);
  if (centerDistance > range + smoke.radius || centerDistance < 0.001) return;
  const base = Math.atan2(smoke.position.y - origin.y, smoke.position.x - origin.x);
  const tangent = Math.asin(Math.min(0.98, smoke.radius / centerDistance));
  const epsilon = 0.004;
  for (const candidate of [base - tangent - epsilon, base - tangent, base, base + tangent, base + tangent + epsilon]) {
    if (angleInCone(candidate, coneAngle, fov)) addAngle(candidate);
  }
}

function angleInCone(rayAngle: number, coneAngle: number, fov: number): boolean {
  return Math.abs(normalizeAngle(rayAngle - coneAngle)) <= fov / 2 + 0.00001;
}

function angleOffsetFromStart(rayAngle: number, start: number): number {
  const offset = normalizeAngle(rayAngle - start);
  return offset < 0 ? offset + Math.PI * 2 : offset;
}

function raycastWithSmoke(map: MapDefinition, smokes: SmokeZone[], origin: Vec2, angle: number, range: number, visionWalls: Wall[]): Vec2 {
  const direction = angleToVector(angle);
  const target = add(origin, mul(direction, range));
  let closest = target;
  let closestDistance = range;

  for (const wall of visionWalls) {
    const hit = lineIntersection(origin, target, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (hitDistance < closestDistance) {
      closest = hit;
      closestDistance = hitDistance;
    }
  }

  for (const smoke of smokes) {
    const smokeDistance = rayCircleIntersectionDistance(origin, direction, smoke.position, smoke.radius, closestDistance);
    if (smokeDistance !== null && smokeDistance < closestDistance) {
      closest = add(origin, mul(direction, smokeDistance));
      closestDistance = smokeDistance;
    }
  }

  return closest;
}

function hasLineOfSightAgainstWalls(map: MapDefinition, from: Vec2, to: Vec2, visionWalls: Wall[]): boolean {
  if (visionWalls === map.walls) return hasLineOfSight(map, from, to);
  return !visionWalls.some((wall) => lineIntersection(from, to, wall.a, wall.b));
}

function rayCircleIntersectionDistance(origin: Vec2, direction: Vec2, center: Vec2, radius: number, maxDistance: number): number | null {
  const offset = { x: origin.x - center.x, y: origin.y - center.y };
  const b = offset.x * direction.x + offset.y * direction.y;
  const c = offset.x * offset.x + offset.y * offset.y - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = -b - root;
  const second = -b + root;
  const distance = first >= 0 ? first : second >= 0 ? second : 0;
  return distance <= maxDistance ? distance : null;
}

function segmentCircleDistance(a: Vec2, b: Vec2, center: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(a, center);
  const t = Math.max(0, Math.min(1, ((center.x - a.x) * dx + (center.y - a.y) * dy) / lengthSq));
  return distance({ x: a.x + dx * t, y: a.y + dy * t }, center);
}
