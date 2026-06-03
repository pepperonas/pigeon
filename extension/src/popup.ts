/** Popup UI: shows connection status + buffered count, and an on/off toggle. */
interface Status {
  connected: boolean;
  queued: number;
  enabled: boolean;
  snapshots: boolean;
}

const dot = document.getElementById("dot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const queued = document.getElementById("queued") as HTMLSpanElement;
const toggle = document.getElementById("toggle") as HTMLInputElement;
const snapToggle = document.getElementById("snapToggle") as HTMLInputElement;

function render(s: Status): void {
  toggle.checked = s.enabled;
  snapToggle.checked = s.snapshots;
  snapToggle.disabled = !s.enabled;
  queued.textContent = String(s.queued);

  dot.classList.remove("on", "off");
  if (!s.enabled) {
    dot.classList.add("off");
    statusText.textContent = "Disabled";
  } else if (s.connected) {
    dot.classList.add("on");
    statusText.textContent = "Connected";
  } else {
    statusText.textContent = "Bridge offline";
  }
}

function ask(message: object): Promise<Status | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp?: Status) => {
      void chrome.runtime.lastError;
      resolve(resp);
    });
  });
}

async function refresh(): Promise<void> {
  const s = await ask({ type: "pigeon-status" });
  if (s) render(s);
}

toggle.addEventListener("change", async () => {
  const s = await ask({ type: "pigeon-set-enabled", enabled: toggle.checked });
  if (s) render(s);
});

snapToggle.addEventListener("change", async () => {
  const s = await ask({ type: "pigeon-set-snapshots", enabled: snapToggle.checked });
  if (s) render(s);
});

void refresh();
const interval = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(interval));
