// Agent Radio's page (`public/listen.html`): the audio channel's controls on their own, with no
// React and nothing else of the panel, so the page stays up while the panel reloads around it.
//
// The player is `audioChannelPlayer.ts`. Built with plain DOM calls, once, and updated from the
// player's state; nothing here is torn down while the page lives. The panel's Profile menu links
// here rather than playing anything itself.

import { AUDIO_NOISE_COLORS, AUDIO_NOISE_LEVEL_MAX } from "@agentdesk/agent-feed-wire";
import {
  audioChannelState,
  pauseListening,
  resumeListening,
  setNoiseColor,
  setNoiseLevel,
  startListening,
  stopListening,
  subscribeAudioChannel,
} from "@/features/audio-channel/audioChannelPlayer";

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), properties);
}

function mount(root: HTMLElement): void {
  const status = make("p", { className: "status" });
  status.setAttribute("role", "status");

  const primary = make("button", { type: "button", className: "primary" });
  const stop = make("button", { type: "button", textContent: "Stop" });
  const controls = make("div", { className: "controls" });
  controls.append(primary, stop);

  const slider = make("input", { type: "range", min: "0", max: String(AUDIO_NOISE_LEVEL_MAX), step: "1", id: "noise" });
  slider.setAttribute("aria-label", "Noise level");
  const readout = make("output");
  readout.setAttribute("for", "noise");
  const noise = make("label", { className: "noise" });
  noise.append(make("span", { textContent: "Noise" }), slider, readout);

  const colors = make("div", { className: "colors" });
  colors.setAttribute("role", "radiogroup");
  colors.setAttribute("aria-label", "Noise color");
  const colorButtons = AUDIO_NOISE_COLORS.map((color) => {
    const button = make("button", { type: "button", textContent: color });
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => setNoiseColor(color));
    colors.append(button);
    return { color, button };
  });

  // Each handler calls the player inside the tap itself: a phone starts audio only from a gesture.
  primary.addEventListener("click", () => {
    const { phase } = audioChannelState();
    if (phase === "playing" || phase === "starting") pauseListening();
    else if (phase === "paused") resumeListening();
    else startListening();
  });
  stop.addEventListener("click", stopListening);
  slider.addEventListener("input", () => setNoiseLevel(Number(slider.value)));

  root.append(status, controls, noise, colors);

  const render = (): void => {
    const state = audioChannelState();
    const running = state.phase === "playing" || state.phase === "starting";
    primary.textContent = running ? "Pause" : state.phase === "paused" ? "Resume" : "Listen";
    stop.hidden = state.phase === "idle";
    status.textContent = state.status ?? "Not listening";
    slider.value = String(state.noise);
    slider.setAttribute("aria-valuetext", state.noise === 0 ? "off" : `${state.noise} of ${AUDIO_NOISE_LEVEL_MAX}`);
    readout.textContent = state.noise === 0 ? "off" : String(state.noise);
    for (const { color, button } of colorButtons) button.setAttribute("aria-checked", String(state.color === color));
  };
  subscribeAudioChannel(render);
  render();
}

const root = document.getElementById("radio");
if (!root) throw new Error("listen.html has no #radio to mount into");
mount(root);
