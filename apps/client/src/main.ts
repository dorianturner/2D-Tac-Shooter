import Phaser from "phaser";
import "./styles/main.css";
import { EditorScene } from "./scenes/EditorScene";
import { editorUnlockKey, MenuScene } from "./scenes/MenuScene";
import { PlayScene } from "./scenes/PlayScene";
import { PreloadScene } from "./scenes/PreloadScene";

const path = window.location.pathname;
const routeScene = path.includes("editor") && sessionStorage.getItem(editorUnlockKey) !== "true" ? "menu" : path.includes("editor") ? "editor" : path.includes("play") ? "play" : "menu";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: "#05070a",
  scene: [new PreloadScene(routeScene), new MenuScene(), new PlayScene(), new EditorScene()],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  render: {
    antialias: true,
    pixelArt: false
  }
});
