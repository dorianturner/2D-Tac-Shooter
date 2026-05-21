import type { MapSummary } from "./editorApi";

export interface Pickable {
  id: string;
  name: string;
  detail?: string;
}

export function pickFromList(title: string, items: Pickable[]): Promise<Pickable | null> {
  return new Promise((resolve) => {
    const shell = document.createElement("section");
    shell.className = "picker-shell";
    shell.innerHTML = `
      <div class="picker-panel">
        <h2>${title}</h2>
        <input class="picker-input" placeholder="Search by name or id" autofocus>
        <div class="picker-list"></div>
        <button class="picker-cancel">Cancel</button>
      </div>
    `;
    const input = shell.querySelector<HTMLInputElement>(".picker-input")!;
    const list = shell.querySelector<HTMLElement>(".picker-list")!;
    const close = (value: Pickable | null) => {
      shell.remove();
      resolve(value);
    };
    const render = () => {
      const query = input.value.trim().toLowerCase();
      const matches = items.filter((item) => fuzzyMatch(`${item.id} ${item.name} ${item.detail ?? ""}`.toLowerCase(), query)).slice(0, 30);
      list.innerHTML = matches.map((item) => `<button data-id="${item.id}"><strong>${item.name}</strong><span>${item.id}${item.detail ? ` | ${item.detail}` : ""}</span></button>`).join("");
    };
    input.addEventListener("input", render);
    list.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
      if (!button) return;
      close(items.find((item) => item.id === button.dataset.id) ?? null);
    });
    shell.querySelector(".picker-cancel")?.addEventListener("click", () => close(null));
    shell.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter") {
        const first = list.querySelector<HTMLButtonElement>("button[data-id]");
        if (first) close(items.find((item) => item.id === first.dataset.id) ?? null);
      }
    });
    document.body.appendChild(shell);
    render();
    input.focus();
  });
}

export function mapSummaryToPickable(map: MapSummary): Pickable {
  return { id: map.id, name: map.name, detail: `v${map.version}` };
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true;
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}
