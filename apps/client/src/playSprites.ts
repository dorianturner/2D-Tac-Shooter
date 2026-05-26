import Phaser from "phaser";
import { segmentPreset, type DeployedCamera, type MolotovZone, type PlayerId, type ServerSnapshot, type SmokeZone, type SoundSensorZone, type Vec2, type Wall, type WeaponPresetId } from "@tac/shared";
import { fxSpriteAssets, gadgetSpriteAssets, imageAssets, playerSpriteAssets, weaponSpriteAssets } from "./assets";

interface RenderedPlayer {
  position: Vec2;
  aim: number;
}

export class PlaySpritePresenter {
  private readonly players = new Map<PlayerId, Phaser.GameObjects.Image>();
  private readonly weapons = new Map<PlayerId, Phaser.GameObjects.Image>();
  private readonly gadgets = new Map<string, Phaser.GameObjects.Image>();

  constructor(private readonly scene: Phaser.Scene) {}

  render(snapshot: ServerSnapshot, renderedPlayers: Map<PlayerId, RenderedPlayer>): void {
    this.renderPlayers(snapshot, renderedPlayers);
    this.renderGadgets(snapshot);
  }

  clear(): void {
    clearImageMap(this.players);
    clearImageMap(this.weapons);
    clearImageMap(this.gadgets);
  }

  private renderPlayers(snapshot: ServerSnapshot, renderedPlayers: Map<PlayerId, RenderedPlayer>): void {
    const live = new Set<PlayerId>();
    for (const player of [snapshot.self, ...snapshot.visiblePlayers]) {
      const rendered = renderedPlayers.get(player.id) ?? { position: player.position, aim: player.aim };
      live.add(player.id);
      const key = player.team === "blue" ? imageAssets.playerBlue.key : imageAssets.playerOrange.key;
      const image = upsertImage(this.scene, this.players, player.id, key, 42);
      image.setPosition(rendered.position.x, rendered.position.y);
      image.setRotation(rendered.aim);
      image.setAlpha(player.id === snapshot.playerId ? 1 : 0.86);
      setMaxWorldSize(image, playerSpriteAssets.worldSize);
      this.renderWeapon(player.id, player.weaponId, rendered, player.id === snapshot.playerId);
    }
    pruneMissing(this.players, live);
    pruneMissing(this.weapons, live);
  }

  private renderWeapon(playerId: PlayerId, weaponId: keyof typeof weaponSpriteAssets, rendered: RenderedPlayer, isSelf: boolean): void {
    const config = weaponSpriteAssets[weaponId] ?? weaponSpriteAssets.assault;
    const image = upsertImage(this.scene, this.weapons, playerId, config.asset.key, 43);
    const { x, y } = pointAlongAim(rendered.position, rendered.aim, config.offsetX);
    image.setPosition(x, y);
    image.setRotation(rendered.aim);
    image.setAlpha(isSelf ? 1 : 0.88);
    setWorldWidth(image, config.worldLength);
  }

  private renderGadgets(snapshot: ServerSnapshot): void {
    const live = new Set<string>();
    for (const camera of snapshot.gadgets.cameras) this.renderCamera(camera, snapshot.playerId, live);
    for (const sensor of snapshot.gadgets.soundSensors) this.renderSoundSensor(sensor, snapshot.tick, live);
    for (const zone of snapshot.gadgets.molotovs) this.renderZone(zone, gadgetSpriteAssets.molotov.asset.key, live, gadgetSpriteAssets.molotov.alpha);
    for (const zone of snapshot.gadgets.smokes) this.renderZone(zone, gadgetSpriteAssets.smoke.asset.key, live, gadgetSpriteAssets.smoke.alpha);
    for (const wall of snapshot.map.walls) this.renderDeployableWall(wall, live);
    pruneMissing(this.gadgets, live);
  }

  private renderCamera(camera: DeployedCamera, playerId: PlayerId, live: Set<string>): void {
    if (camera.destroyed) return;
    const id = `camera:${camera.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, gadgetSpriteAssets.camera.asset.key, 41);
    image.setPosition(camera.position.x, camera.position.y);
    image.setRotation(0);
    setMaxWorldSize(image, gadgetSpriteAssets.camera.worldSize);
    image.setAlpha(camera.owner === playerId ? 1 : 0.68);
  }

  private renderSoundSensor(sensor: SoundSensorZone, tick: number, live: Set<string>): void {
    const id = `sound:${sensor.id}`;
    live.add(id);
    const triggered = (sensor.triggeredUntilTick ?? 0) >= tick;
    const image = upsertImage(this.scene, this.gadgets, id, gadgetSpriteAssets.soundSensor.asset.key, 41);
    image.setPosition(sensor.position.x, sensor.position.y);
    image.setRotation(0);
    setMaxWorldSize(image, gadgetSpriteAssets.soundSensor.worldSize * (triggered ? 1.12 : 1));
    image.setAlpha(triggered ? 0.9 : 0.75);
  }

  private renderZone(zone: MolotovZone | SmokeZone, key: string, live: Set<string>, alpha: number): void {
    const id = `${key}:${zone.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, key, 39);
    image.setPosition(zone.position.x, zone.position.y);
    image.setRotation(0);
    setMaxWorldSize(image, key === gadgetSpriteAssets.smoke.asset.key ? gadgetSpriteAssets.smoke.worldSize : gadgetSpriteAssets.molotov.worldSize);
    image.setAlpha(alpha);
  }

  private renderDeployableWall(wall: Wall, live: Set<string>): void {
    if (segmentPreset(wall) !== "deployable-wall" || wall.destroyed) return;
    const id = `wall:${wall.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, imageAssets.deployableWall.key, 40);
    const angle = Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
    image.setPosition((wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2);
    image.setRotation(angle);
    image.setScale(Math.max(0.5, Phaser.Math.Distance.Between(wall.a.x, wall.a.y, wall.b.x, wall.b.y) / 64), Math.max(0.5, wall.thickness / 10));
    image.setAlpha(0.92);
  }
}

export function playImpactSprite(scene: Phaser.Scene, position: Vec2): void {
  const image = scene.add.image(position.x, position.y, fxSpriteAssets.bulletImpact.asset.key).setDepth(61).setAlpha(0.9);
  setMaxWorldSize(image, fxSpriteAssets.bulletImpact.worldSize);
  scene.tweens.add({ targets: image, alpha: 0, scale: 0.8, duration: 140, onComplete: () => image.destroy() });
}

export function playMuzzleFlashSprite(scene: Phaser.Scene, origin: Vec2, aim: number): void {
  const image = scene.add.image(origin.x, origin.y, fxSpriteAssets.muzzleFlash.asset.key).setDepth(60).setRotation(aim).setAlpha(0.9);
  setWorldWidth(image, fxSpriteAssets.muzzleFlash.worldLength);
  scene.tweens.add({ targets: image, alpha: 0, scale: 0.72, duration: 90, onComplete: () => image.destroy() });
}

export function muzzleWorldPoint(position: Vec2, aim: number, weaponId: WeaponPresetId): Vec2 {
  const config = weaponSpriteAssets[weaponId] ?? weaponSpriteAssets.assault;
  return pointAlongAim(position, aim, weaponMuzzleOffset(config));
}

function upsertImage<T extends string>(scene: Phaser.Scene, map: Map<T, Phaser.GameObjects.Image>, id: T, key: string, depth: number): Phaser.GameObjects.Image {
  const existing = map.get(id);
  if (existing && existing.texture.key === key) return existing;
  existing?.destroy();
  const image = scene.add.image(0, 0, key).setDepth(depth).setOrigin(0.5, 0.5);
  map.set(id, image);
  return image;
}

function pruneMissing<T extends string>(map: Map<T, Phaser.GameObjects.Image>, live: Set<T>): void {
  for (const [id, image] of map) {
    if (live.has(id)) continue;
    image.destroy();
    map.delete(id);
  }
}

function clearImageMap<T extends string>(map: Map<T, Phaser.GameObjects.Image>): void {
  for (const image of map.values()) image.destroy();
  map.clear();
}

function setMaxWorldSize(image: Phaser.GameObjects.Image, size: number): void {
  const sourceMax = Math.max(image.width, image.height, 1);
  image.setScale(size / sourceMax);
}

function setWorldWidth(image: Phaser.GameObjects.Image, width: number): void {
  image.setScale(width / Math.max(image.width, 1));
}

function pointAlongAim(position: Vec2, aim: number, offset: number): Vec2 {
  return { x: position.x + Math.cos(aim) * offset, y: position.y + Math.sin(aim) * offset };
}

function weaponMuzzleOffset(config: { offsetX: number; worldLength: number }): number {
  return config.offsetX + config.worldLength / 2;
}
