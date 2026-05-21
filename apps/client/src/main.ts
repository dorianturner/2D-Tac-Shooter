import Phaser from "phaser";
import "./styles/main.css";
import { EditorScene } from "./scenes/EditorScene";
import { MenuScene } from "./scenes/MenuScene";
import { PlayScene } from "./scenes/PlayScene";

const path = window.location.pathname;
const scene = path.includes("editor") ? new EditorScene() : path.includes("play") ? new PlayScene() : new MenuScene();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: "#05070a",
  scene,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  render: {
    antialias: true,
    pixelArt: false
  }
});
