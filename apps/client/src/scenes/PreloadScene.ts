import Phaser from "phaser";
import { imageAssetList, imageAssets, weaponSpriteAssets, type ImageAssetDefinition } from "../assets";
import { colors } from "../render";

const NORMALIZED_PLAYER_TEXTURE_SIZE = 64;
const NORMALIZED_PLAYER_VISIBLE_FRACTION = 0.82;

export class PreloadScene extends Phaser.Scene {
  constructor(private readonly nextScene: string) {
    super("preload");
  }

  preload(): void {
    for (const asset of imageAssetList) {
      if (!asset.path) continue;
      this.load.image(sourceTextureKey(asset), asset.path);
    }
  }

  create(): void {
    normalizePlayerTexture(this, imageAssets.playerBlue);
    normalizePlayerTexture(this, imageAssets.playerOrange);
    for (const asset of imageAssetList) {
      if (asset.id !== "playerBlue" && asset.id !== "playerOrange") normalizeCroppedTexture(this, asset);
    }
    createFallbackTextures(this);
    this.scene.start(this.nextScene);
  }
}

function sourceTextureKey(asset: ImageAssetDefinition): string {
  return `${asset.key}.source`;
}

function normalizePlayerTexture(scene: Phaser.Scene, asset: ImageAssetDefinition): void {
  const sourceKey = sourceTextureKey(asset);
  if (scene.textures.exists(asset.key) || !scene.textures.exists(sourceKey)) return;
  const source = scene.textures.get(sourceKey).getSourceImage() as HTMLCanvasElement | HTMLImageElement;
  const crop = alphaCropBounds(source);
  if (!crop) return;

  const canvas = document.createElement("canvas");
  canvas.width = NORMALIZED_PLAYER_TEXTURE_SIZE;
  canvas.height = NORMALIZED_PLAYER_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const sourceMax = Math.max(crop.width, crop.height);
  const targetSize = NORMALIZED_PLAYER_TEXTURE_SIZE * NORMALIZED_PLAYER_VISIBLE_FRACTION;
  const scale = targetSize / Math.max(1, sourceMax);
  const drawWidth = crop.width * scale;
  const drawHeight = crop.height * scale;
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    (NORMALIZED_PLAYER_TEXTURE_SIZE - drawWidth) / 2,
    (NORMALIZED_PLAYER_TEXTURE_SIZE - drawHeight) / 2,
    drawWidth,
    drawHeight
  );

  scene.textures.addCanvas(asset.key, canvas);
}

function normalizeCroppedTexture(scene: Phaser.Scene, asset: ImageAssetDefinition): void {
  const sourceKey = sourceTextureKey(asset);
  if (scene.textures.exists(asset.key) || !scene.textures.exists(sourceKey)) return;
  const source = scene.textures.get(sourceKey).getSourceImage() as HTMLCanvasElement | HTMLImageElement;
  const crop = alphaCropBounds(source);
  if (!crop) return;

  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  scene.textures.addCanvas(asset.key, canvas);
}

function alphaCropBounds(source: HTMLCanvasElement | HTMLImageElement): { x: number; y: number; width: number; height: number } | null {
  const width = source.width;
  const height = source.height;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]! < 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function createFallbackTextures(scene: Phaser.Scene): void {
  createPlayerFallback(scene, imageAssets.playerBlue.key, colors.blue);
  createPlayerFallback(scene, imageAssets.playerOrange.key, colors.orange);
  createWeaponFallback(scene, weaponSpriteAssets.assault.asset.key, 56);
  createWeaponFallback(scene, weaponSpriteAssets.sniper.asset.key, 68);
  createWeaponFallback(scene, weaponSpriteAssets.shotgun.asset.key, 60);
  createCircleIcon(scene, imageAssets.camera.key, colors.sensor, "camera");
  createCircleIcon(scene, imageAssets.soundSensor.key, colors.sensor, "sound");
  createCircleIcon(scene, imageAssets.molotov.key, colors.destructible, "molotov");
  createCircleIcon(scene, imageAssets.smoke.key, 0xb6c3cc, "smoke");
  createDeployableWallFallback(scene);
  createMuzzleFlashFallback(scene);
  createImpactFallback(scene);
}

function createWeaponFallback(scene: Phaser.Scene, key: string, width: number): void {
  if (scene.textures.exists(key)) return;
  const height = 18;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x141a1f, 0.96);
  g.fillRoundedRect(4, 6, width - 12, 6, 2);
  g.fillStyle(0x29323a, 0.96);
  g.fillRoundedRect(8, 10, Math.max(14, width * 0.32), 6, 2);
  g.fillStyle(0x3c4650, 0.96);
  g.fillRect(width - 8, 7, 6, 4);
  g.lineStyle(1, 0x9aa8b0, 0.7);
  g.strokeRoundedRect(4, 6, width - 12, 6, 2);
  g.generateTexture(key, width, height);
  g.destroy();
}

function createPlayerFallback(scene: Phaser.Scene, key: string, color: number): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(color, 1);
  g.fillCircle(24, 24, 13);
  g.lineStyle(4, color, 0.95);
  g.lineBetween(24, 24, 48, 24);
  g.fillStyle(0xd7f3ff, 0.9);
  g.fillCircle(31, 24, 3);
  g.generateTexture(key, 56, 48);
  g.destroy();
}

function createCircleIcon(scene: Phaser.Scene, key: string, color: number, variant: "camera" | "sound" | "molotov" | "smoke"): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const alpha = variant === "smoke" ? 0.45 : 0.9;
  g.fillStyle(color, variant === "molotov" ? 0.72 : variant === "smoke" ? 0.34 : 0.62);
  g.fillCircle(24, 24, variant === "smoke" ? 22 : 10);
  g.lineStyle(3, color, alpha);
  g.strokeCircle(24, 24, variant === "sound" ? 15 : 13);
  if (variant === "camera") g.lineBetween(24, 24, 38, 18);
  if (variant === "sound") {
    g.strokeCircle(24, 24, 20);
    g.lineBetween(24, 24, 24, 10);
  }
  if (variant === "molotov") {
    g.fillStyle(0xff6f3c, 0.92);
    g.fillTriangle(24, 7, 34, 28, 18, 28);
  }
  g.generateTexture(key, 48, 48);
  g.destroy();
}

function createDeployableWallFallback(scene: Phaser.Scene): void {
  const key = imageAssets.deployableWall.key;
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(colors.wall, 0.9);
  g.fillRoundedRect(4, 18, 56, 12, 2);
  g.lineStyle(2, colors.destructible, 0.8);
  g.strokeRoundedRect(4, 18, 56, 12, 2);
  g.generateTexture(key, 64, 48);
  g.destroy();
}

function createMuzzleFlashFallback(scene: Phaser.Scene): void {
  const key = imageAssets.muzzleFlash.key;
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xfff1a8, 0.9);
  g.fillTriangle(0, 12, 42, 2, 42, 22);
  g.fillStyle(colors.destructible, 0.7);
  g.fillTriangle(8, 12, 34, 6, 34, 18);
  g.generateTexture(key, 48, 24);
  g.destroy();
}

function createImpactFallback(scene: Phaser.Scene): void {
  const key = imageAssets.bulletImpact.key;
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.lineStyle(3, colors.destructible, 0.9);
  g.lineBetween(16, 2, 16, 30);
  g.lineBetween(2, 16, 30, 16);
  g.lineBetween(6, 6, 26, 26);
  g.lineBetween(26, 6, 6, 26);
  g.generateTexture(key, 32, 32);
  g.destroy();
}
