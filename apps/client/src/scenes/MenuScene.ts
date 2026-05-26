import Phaser from "phaser";
import { colors } from "../render";

const editorPassword = "364726";
export const editorUnlockKey = "sightline.editor.unlocked";

export class MenuScene extends Phaser.Scene {
  private shell: HTMLElement | undefined;

  constructor() {
    super("menu");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    this.shell = document.createElement("main");
    this.shell.className = "menu-shell";
    this.shell.innerHTML = `
      <section class="menu-panel">
        <p class="eyebrow">1v1 Information Warfare</p>
        <h1>Sightline</h1>
        <p class="menu-copy">Create a local match on a saved tactical map, or unlock the editor to build geometry, doors, spawns, and objectives.</p>
        <div class="menu-actions">
          <a class="primary-action" href="/play">Play</a>
          <button class="secondary-action" data-action="editor">Map Editor</button>
        </div>
        <form class="editor-password" data-editor-password hidden>
          <label>Editor password
            <input inputmode="numeric" autocomplete="off" maxlength="12" data-editor-input>
          </label>
          <button class="primary-action" type="submit">Unlock Editor</button>
          <button class="secondary-action" type="button" data-action="cancel-editor">Cancel</button>
          <p data-editor-error></p>
        </form>
      </section>
    `;
    document.body.appendChild(this.shell);
    this.shell.querySelector("[data-action='editor']")?.addEventListener("click", () => this.openEditorGate());
    this.shell.querySelector("[data-action='cancel-editor']")?.addEventListener("click", () => this.closeEditorGate());
    this.shell.querySelector<HTMLFormElement>("[data-editor-password]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitEditorPassword();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.shell?.remove());
  }

  private openEditorGate(): void {
    if (sessionStorage.getItem(editorUnlockKey) === "true") {
      window.location.href = "/editor";
      return;
    }
    const form = this.shell?.querySelector<HTMLElement>("[data-editor-password]");
    form?.removeAttribute("hidden");
    this.shell?.querySelector<HTMLInputElement>("[data-editor-input]")?.focus();
  }

  private closeEditorGate(): void {
    this.shell?.querySelector<HTMLElement>("[data-editor-password]")?.setAttribute("hidden", "true");
    const error = this.shell?.querySelector<HTMLElement>("[data-editor-error]");
    if (error) error.textContent = "";
  }

  private submitEditorPassword(): void {
    const input = this.shell?.querySelector<HTMLInputElement>("[data-editor-input]");
    const error = this.shell?.querySelector<HTMLElement>("[data-editor-error]");
    if (input?.value.trim() === editorPassword) {
      sessionStorage.setItem(editorUnlockKey, "true");
      window.location.href = "/editor";
      return;
    }
    if (error) error.textContent = "Incorrect password.";
  }
}
