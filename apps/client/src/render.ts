import Phaser from "phaser";
import type { Detection, MapDefinition, ServerSnapshot, Vec2, Wall } from "@tac/shared";

export const colors = {
  bg: 0x05070a,
  grid: 0x102836,
  wall: 0x8fb6c5,
  destructible: 0xffcc66,
  destroyed: 0x31404a,
  blue: 0x24a8ff,
  orange: 0xff6f3c,
  fog: 0x020406,
  explored: 0x23404d,
  sensor: 0x5df2b6,
  warning: 0xff4f67
};

export function drawMap(g: Phaser.GameObjects.Graphics, map: MapDefinition): void {
  g.clear();
  g.fillStyle(colors.bg, 1);
  g.fillRect(0, 0, map.bounds.width, map.bounds.height);
  g.lineStyle(1, colors.grid, 0.5);
  const gridSize = map.gridSize ?? 40;
  for (let x = 0; x <= map.bounds.width; x += gridSize) g.lineBetween(x, 0, x, map.bounds.height);
  for (let y = 0; y <= map.bounds.height; y += gridSize) g.lineBetween(0, y, map.bounds.width, y);
  for (const wall of map.walls) drawWall(g, wall);
}

export function drawWall(g: Phaser.GameObjects.Graphics, wall: Wall): void {
  const kind = wall.kind ?? (wall.blocksVision ? "solid" : "transparent");
  const color = wall.destroyed ? colors.destroyed : kind === "door" ? colors.sensor : kind === "mesh" ? 0xb6f2df : kind === "transparent" ? 0x67d7ff : colors.wall;
  const alpha = wall.destroyed ? 0.18 : kind === "door" ? 0.72 : kind === "transparent" ? 0.48 : 0.92;
  g.lineStyle(Math.max(2, wall.thickness), color, alpha);
  g.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
  if (wall.destructible && !wall.destroyed) {
    g.lineStyle(2, colors.destructible, 0.95);
    g.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
  }
  if (kind === "transparent") {
    g.lineStyle(1, color, 0.8);
    g.strokeCircle((wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2, 7);
  }
}

export function drawSnapshot(g: Phaser.GameObjects.Graphics, snapshot: ServerSnapshot): void {
  for (const point of snapshot.explored) {
    g.fillStyle(colors.explored, 0.08);
    g.fillCircle(point.x, point.y, 48);
  }
  g.fillStyle(0x173f4f, 0.18);
  fillPolygon(g, snapshot.visiblePolygon);
  drawPlayer(g, snapshot.self.position, snapshot.self.team === "blue" ? colors.blue : colors.orange, true, snapshot.self.aim);
  for (const player of snapshot.visiblePlayers) {
    drawPlayer(g, player.position, player.team === "blue" ? colors.blue : colors.orange, false, player.aim);
  }
  for (const detection of snapshot.detections) drawDetection(g, detection);
  for (const sensor of snapshot.map.sensors) {
    if (sensor.destroyed) continue;
    g.lineStyle(1, colors.sensor, sensor.corrupted ? 0.25 : 0.42);
    if (sensor.fov >= Math.PI * 1.9) {
      g.strokeCircle(sensor.position.x, sensor.position.y, sensor.range);
    } else {
      const start = sensor.angle - sensor.fov / 2;
      const end = sensor.angle + sensor.fov / 2;
      g.beginPath();
      g.moveTo(sensor.position.x, sensor.position.y);
      g.arc(sensor.position.x, sensor.position.y, sensor.range, start, end, false);
      g.closePath();
      g.strokePath();
    }
    g.fillStyle(colors.sensor, 0.9);
    g.fillCircle(sensor.position.x, sensor.position.y, 5);
  }
  if (snapshot.debug) {
    g.lineStyle(1, colors.warning, 0.38);
    for (const poly of Object.values(snapshot.debug.visibleByPlayer)) {
      for (let i = 0; i < poly.length; i += 4) {
        const p = poly[i];
        if (p) g.lineBetween(snapshot.self.position.x, snapshot.self.position.y, p.x, p.y);
      }
    }
  }
}

export function drawPlayer(g: Phaser.GameObjects.Graphics, position: Vec2, color: number, self: boolean, aim: number): void {
  g.fillStyle(color, self ? 1 : 0.86);
  g.fillCircle(position.x, position.y, self ? 15 : 13);
  g.lineStyle(3, color, 0.9);
  g.lineBetween(position.x, position.y, position.x + Math.cos(aim) * 30, position.y + Math.sin(aim) * 30);
}

function drawDetection(g: Phaser.GameObjects.Graphics, detection: Detection): void {
  g.lineStyle(2, detection.kind === "motion-pulse" ? colors.warning : colors.sensor, detection.confidence);
  g.strokeCircle(detection.position.x, detection.position.y, 22 + (1 - detection.confidence) * 24);
  g.fillStyle(detection.kind === "motion-pulse" ? colors.warning : colors.sensor, 0.2);
  g.fillCircle(detection.position.x, detection.position.y, 8);
}

export function fillPolygon(g: Phaser.GameObjects.Graphics, points: Vec2[]): void {
  if (points.length < 3) return;
  g.beginPath();
  g.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) g.lineTo(point.x, point.y);
  g.closePath();
  g.fillPath();
}
