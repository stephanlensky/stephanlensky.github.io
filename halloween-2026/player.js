import { decompress } from "./vendor/fzstd.mjs";

const OFF_LEVEL = 14;
const GAP_RATIO = 0.2;
const MIN_GRID_PITCH = 4;
const FRAME_EPSILON = 0.01;
const MAX_DRIFT = 0.15;
const MAX_RATE_CORRECTION = 0.05;
const CACHE_SIZE = 3;
const PREFETCH_PROGRESS = 0.5;
const RETRY_DELAY = 2000;
const LOADING_DELAY = 300;
const IDLE_DELAY = 2600;
const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;
const VOLUME_STORAGE_KEY = "halloween-2026-volume";

const player = document.querySelector(".player");
const stage = player.querySelector(".stage");
const deck = stage.querySelector(".deck");
const media = stage.querySelector(".media");
const slot = stage.querySelector(".slot");
const controls = stage.querySelector(".controls");
const screen = stage.querySelector(".screen");
const panelCanvas = stage.querySelector(".panel");
const camera = stage.querySelector(".camera");
const playButton = stage.querySelector(".play");
const muteButton = stage.querySelector(".mute");
const volumeSlider = stage.querySelector(".volume-slider");
const fullscreenButton = stage.querySelector(".fullscreen");
const seek = stage.querySelector(".seek");
const seekTooltip = stage.querySelector(".seek-tooltip");
const currentTimeLabel = stage.querySelector(".time-current");
const durationLabel = stage.querySelector(".time-duration");
const viewInputs = player.querySelectorAll('input[name="view"]');
const mediaUrl = player.dataset.mediaUrl;

class LedFrames {
  constructor(url) {
    this.url = url;
    this.manifest = null;
    this.chunks = new Map();
    this.requests = new Map();
    this.failures = new Map();
  }

  async load() {
    const response = await fetch(`${this.url}/manifest.json`);
    if (!response.ok) {
      throw new Error(`Manifest request failed with ${response.status}`);
    }
    this.manifest = await response.json();
    const { width, height, channels } = this.manifest;
    this.frameBytes = width * height * channels;
  }

  get duration() {
    return this.manifest.frameCount / this.manifest.fps;
  }

  getFrameIndex(time) {
    const { fps, frameCount } = this.manifest;
    return Math.max(0, Math.min(frameCount - 1, Math.floor(time * fps + FRAME_EPSILON)));
  }

  getChunkIndex(frameIndex) {
    return Math.floor(frameIndex / this.manifest.chunkFrames);
  }

  getChunkUrl(chunkIndex) {
    const { chunkPath, chunkIndexDigits } = this.manifest;
    return `${this.url}/${chunkPath.replace("{index}", String(chunkIndex).padStart(chunkIndexDigits, "0"))}`;
  }

  getWantedChunks(frameIndex) {
    const { chunkFrames, chunkCount } = this.manifest;
    const chunkIndex = this.getChunkIndex(frameIndex);
    const progress = (frameIndex % chunkFrames) / chunkFrames;
    if (progress >= PREFETCH_PROGRESS && chunkIndex + 1 < chunkCount) {
      return [chunkIndex, chunkIndex + 1];
    }
    return [chunkIndex];
  }

  setWantedChunks(chunkIndices) {
    for (const [chunkIndex, controller] of this.requests) {
      if (!chunkIndices.includes(chunkIndex)) {
        controller.abort();
        this.requests.delete(chunkIndex);
      }
    }
    for (const chunkIndex of chunkIndices) {
      this.requestChunk(chunkIndex);
    }
  }

  requestChunk(chunkIndex) {
    if (this.chunks.has(chunkIndex) || this.requests.has(chunkIndex)) {
      return;
    }
    if (performance.now() - (this.failures.get(chunkIndex) ?? -Infinity) < RETRY_DELAY) {
      return;
    }
    const controller = new AbortController();
    this.requests.set(chunkIndex, controller);
    fetch(this.getChunkUrl(chunkIndex), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Chunk ${chunkIndex} request failed with ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => {
        this.setChunk(chunkIndex, getChunkFrames(new Uint8Array(buffer), this.frameBytes));
        this.failures.delete(chunkIndex);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          this.failures.set(chunkIndex, performance.now());
        }
      })
      .finally(() => {
        if (this.requests.get(chunkIndex) === controller) {
          this.requests.delete(chunkIndex);
        }
      });
  }

  setChunk(chunkIndex, frames) {
    this.chunks.set(chunkIndex, frames);
    while (this.chunks.size > CACHE_SIZE) {
      this.chunks.delete(this.chunks.keys().next().value);
    }
  }

  getFrame(frameIndex) {
    const chunkIndex = this.getChunkIndex(frameIndex);
    const frames = this.chunks.get(chunkIndex);
    if (!frames) {
      return null;
    }
    this.chunks.delete(chunkIndex);
    this.chunks.set(chunkIndex, frames);
    const offset = (frameIndex - chunkIndex * this.manifest.chunkFrames) * this.frameBytes;
    return frames.subarray(offset, offset + this.frameBytes);
  }
}

function getChunkFrames(compressed, frameBytes) {
  const data = decompress(compressed);
  for (let offset = frameBytes; offset < data.length; offset++) {
    data[offset] ^= data[offset - frameBytes];
  }
  return data;
}

function getCellMap(count, pitch, gap) {
  const map = new Int16Array(Math.round(count * pitch) - gap).fill(-1);
  for (let cell = 0; cell < count; cell++) {
    map.fill(cell, Math.round(cell * pitch), Math.round((cell + 1) * pitch) - gap);
  }
  return map;
}

function getLevel(value) {
  return OFF_LEVEL + (value * (255 - OFF_LEVEL)) / 255;
}

class PanelRenderer {
  constructor(canvas, width, height, channels) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.colors = new ImageData(width, height);
    this.colorWords = new Uint32Array(this.colors.data.buffer);
    this.levels = Uint8ClampedArray.from({ length: 256 }, (_, value) => getLevel(value));
    this.layout = null;
  }

  setSize(cssSize) {
    const pitch = Math.max(1, (cssSize * devicePixelRatio) / this.width);
    const gap = pitch >= MIN_GRID_PITCH ? Math.max(1, Math.round(pitch * GAP_RATIO)) : 0;
    const columns = getCellMap(this.width, pitch, gap);
    const rows = getCellMap(this.height, pitch, gap);
    this.layout = { columns, rows, image: new ImageData(columns.length, rows.length) };
    this.canvas.width = columns.length;
    this.canvas.height = rows.length;
    this.canvas.style.width = `${columns.length / devicePixelRatio}px`;
    this.canvas.style.height = `${rows.length / devicePixelRatio}px`;
  }

  setFrame(frame) {
    const colors = this.colors.data;
    for (let pixel = 0; pixel < this.width * this.height; pixel++) {
      const source = pixel * this.channels;
      const target = pixel * 4;
      colors[target] = this.levels[frame[source]];
      colors[target + 1] = this.levels[frame[source + 1]];
      colors[target + 2] = this.levels[frame[source + 2]];
      colors[target + 3] = 255;
    }
  }

  draw() {
    if (!this.layout) {
      return;
    }
    const { columns, rows, image } = this.layout;
    const imageWords = new Uint32Array(image.data.buffer);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      const offset = y * columns.length;
      if (row < 0) {
        imageWords.fill(0, offset, offset + columns.length);
        continue;
      }
      const rowOffset = row * this.width;
      for (let x = 0; x < columns.length; x++) {
        const column = columns[x];
        imageWords[offset + x] = column < 0 ? 0 : this.colorWords[rowOffset + column];
      }
    }
    this.context.putImageData(image, 0, 0);
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function getStoredVolume() {
  try {
    const stored = JSON.parse(localStorage.getItem(VOLUME_STORAGE_KEY));
    return typeof stored?.volume === "number" ? stored : null;
  } catch {
    return null;
  }
}

function setStoredVolume() {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: deck.volume, muted: deck.muted }));
  } catch {}
}

const leds = new LedFrames(`${mediaUrl}/led`);
let renderer = null;
let started = false;
let view = "rendered";
let heldForCamera = false;
let cameraPending = false;
let drawnFrameIndex = -1;
let layoutChanged = true;
let missingFrameSince = null;
let lastMediaTime = null;
let dragging = false;
let idleTimer = null;
let duration = 2762.9333;

deck.src = `${mediaUrl}/deck.mp4`;

function getTime() {
  if (!started) {
    return 0;
  }
  if (!deck.paused && lastMediaTime !== null && !deck.seeking) {
    return lastMediaTime;
  }
  return deck.currentTime;
}

function isPlaying() {
  return !deck.paused || heldForCamera;
}

function reveal() {
  if (started) {
    return;
  }
  started = true;
  stage.dataset.started = "true";
  if (view === "camera") {
    showCamera();
  }
}

function start() {
  reveal();
  play();
  setIdleTimer();
}

function play() {
  reveal();
  heldForCamera = false;
  deck.play().catch(() => {});
}

function pause() {
  heldForCamera = false;
  deck.pause();
  camera.pause();
}

function togglePlay() {
  if (isPlaying()) {
    pause();
  } else {
    play();
  }
}

function setCurrentTime(time) {
  reveal();
  deck.currentTime = Math.max(0, Math.min(duration, time));
}

function setView(nextView) {
  if (nextView === view) {
    return;
  }
  view = nextView;
  if (view === "camera") {
    showCamera();
  } else {
    hideCamera();
  }
}

function showCamera() {
  if (!started) {
    stage.dataset.view = "camera";
    return;
  }
  if (!camera.src) {
    camera.removeAttribute("poster");
    camera.preload = "auto";
    camera.src = `${mediaUrl}/panel-camera.mp4`;
  }
  cameraPending = true;
  camera.currentTime = deck.currentTime;
  camera.playbackRate = 1;
  if (!deck.paused) {
    camera.play().catch(() => {});
  }
  updateCameraReady();
}

function updateCameraReady() {
  if (cameraPending && view === "camera" && camera.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !camera.seeking) {
    cameraPending = false;
    stage.dataset.view = "camera";
  }
}

function hideCamera() {
  cameraPending = false;
  stage.dataset.view = "rendered";
  camera.pause();
  if (heldForCamera) {
    heldForCamera = false;
    deck.play().catch(() => {});
  }
}

function syncCamera() {
  if (heldForCamera && camera.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !camera.seeking) {
    heldForCamera = false;
    deck.play().catch(() => {});
    return;
  }
  if (view !== "camera" || !started || deck.paused || camera.seeking || camera.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    return;
  }
  const drift = camera.currentTime - deck.currentTime;
  if (Math.abs(drift) > MAX_DRIFT) {
    camera.currentTime = deck.currentTime;
    camera.playbackRate = 1;
  } else {
    camera.playbackRate = 1 - Math.max(-MAX_RATE_CORRECTION, Math.min(MAX_RATE_CORRECTION, drift));
  }
  if (camera.paused) {
    camera.play().catch(() => {});
  }
}

function updatePanel(time, now) {
  if (!leds.manifest) {
    return;
  }
  const frameIndex = leds.getFrameIndex(time);
  const wanted = leds.getWantedChunks(frameIndex);
  if (!started) {
    wanted.push(0);
  }
  leds.setWantedChunks(wanted);
  const frame = leds.getFrame(frameIndex);
  if (!frame) {
    missingFrameSince ??= now;
    return;
  }
  missingFrameSince = null;
  if (frameIndex === drawnFrameIndex && !layoutChanged) {
    return;
  }
  drawnFrameIndex = frameIndex;
  layoutChanged = false;
  renderer.setFrame(frame);
  renderer.draw();
}

function updateLoading(now) {
  const waitingForLeds = view === "rendered" && started && missingFrameSince !== null && now - missingFrameSince > LOADING_DELAY;
  const waitingForMedia = started && (heldForCamera || (deck.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !deck.paused) || (cameraPending && view === "camera"));
  stage.dataset.loading = String(waitingForLeds || waitingForMedia);
}

function updateControls(time) {
  stage.dataset.playing = String(isPlaying());
  playButton.setAttribute("aria-label", isPlaying() ? "Pause" : "Play");
  currentTimeLabel.textContent = formatTime(time);
  seek.style.setProperty("--progress", `${(time / duration) * 100}%`);
  seek.setAttribute("aria-valuenow", String(Math.floor(time)));
  seek.setAttribute("aria-valuetext", `${formatTime(time)} of ${formatTime(duration)}`);
  const { buffered } = deck;
  let bufferedEnd = 0;
  for (let index = 0; index < buffered.length; index++) {
    if (buffered.start(index) <= deck.currentTime + 0.5) {
      bufferedEnd = Math.max(bufferedEnd, buffered.end(index));
    }
  }
  seek.style.setProperty("--buffered", `${(bufferedEnd / duration) * 100}%`);
}

function update(now) {
  const time = getTime();
  updatePanel(time, now);
  syncCamera();
  updateLoading(now);
  updateControls(time);
  requestAnimationFrame(update);
}

function onDeckFrame(_, metadata) {
  lastMediaTime = metadata.mediaTime;
  deck.requestVideoFrameCallback(onDeckFrame);
}

function setScreenSize() {
  const style = getComputedStyle(slot);
  const width = slot.clientWidth * Number(style.getPropertyValue("--screen-width"));
  const height = slot.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const size = Math.floor(document.fullscreenElement ? Math.min(width, height) : width);
  if (size <= 0) {
    return;
  }
  screen.style.setProperty("--screen-size", `${size}px`);
  renderer?.setSize(size);
  layoutChanged = true;
}

function setIdleTimer() {
  stage.dataset.idle = "false";
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (isPlaying() && !dragging && !controls.matches(":hover")) {
      stage.dataset.idle = "true";
    }
  }, IDLE_DELAY);
}

function updateVolume() {
  const volume = deck.muted ? 0 : deck.volume;
  volumeSlider.value = String(volume);
  volumeSlider.style.setProperty("--value", `${volume * 100}%`);
  stage.dataset.volume = volume === 0 ? "muted" : volume < 0.5 ? "low" : "high";
  muteButton.setAttribute("aria-label", deck.muted ? "Unmute" : "Mute");
}

function getSeekTime(event) {
  const rect = seek.getBoundingClientRect();
  return (Math.max(0, Math.min(rect.width, event.clientX - rect.left)) / rect.width) * duration;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen().catch(() => {});
  } else {
    stage.webkitRequestFullscreen?.();
  }
}

playButton.addEventListener("click", togglePlay);
media.addEventListener("click", () => (started ? togglePlay() : start()));
media.addEventListener("dblclick", () => started && toggleFullscreen());
stage.addEventListener("pointermove", setIdleTimer);
stage.addEventListener("pointerdown", setIdleTimer);
stage.addEventListener("pointerleave", () => {
  if (isPlaying()) {
    stage.dataset.idle = "true";
  }
});

deck.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(deck.duration)) {
    duration = deck.duration;
    durationLabel.textContent = formatTime(duration);
    seek.setAttribute("aria-valuemax", String(Math.floor(duration)));
  }
});
deck.addEventListener("play", () => {
  lastMediaTime = null;
  setIdleTimer();
  if (view === "camera") {
    camera.play().catch(() => {});
  }
});
deck.addEventListener("pause", () => {
  lastMediaTime = null;
  stage.dataset.idle = "false";
  if (!heldForCamera) {
    camera.pause();
  }
});
deck.addEventListener("seeking", () => {
  lastMediaTime = null;
  if (view === "camera" && camera.src) {
    camera.currentTime = deck.currentTime;
  }
});
deck.addEventListener("waiting", () => {
  if (view === "camera") {
    camera.pause();
  }
});
deck.addEventListener("playing", () => {
  if (view === "camera") {
    camera.play().catch(() => {});
  }
});
deck.addEventListener("ended", () => {
  camera.pause();
  stage.dataset.idle = "false";
});
deck.addEventListener("volumechange", () => {
  updateVolume();
  setStoredVolume();
});

camera.addEventListener("waiting", () => {
  if (view === "camera" && !deck.paused) {
    heldForCamera = true;
    deck.pause();
  }
});
for (const eventName of ["loadeddata", "seeked", "canplay"]) {
  camera.addEventListener(eventName, updateCameraReady);
}

for (const input of viewInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      setView(input.value);
    }
  });
}

muteButton.addEventListener("click", () => {
  if (deck.muted || deck.volume === 0) {
    deck.muted = false;
    if (deck.volume === 0) {
      deck.volume = 1;
    }
  } else {
    deck.muted = true;
  }
});
volumeSlider.addEventListener("input", () => {
  deck.volume = Number(volumeSlider.value);
  deck.muted = deck.volume === 0;
});

fullscreenButton.addEventListener("click", toggleFullscreen);
if (!document.fullscreenEnabled && !stage.webkitRequestFullscreen) {
  player.dataset.fullscreen = "unsupported";
}
document.addEventListener("fullscreenchange", setScreenSize);

seek.addEventListener("pointerdown", (event) => {
  dragging = true;
  seek.dataset.dragging = "true";
  seek.setPointerCapture(event.pointerId);
  setCurrentTime(getSeekTime(event));
});
seek.addEventListener("pointermove", (event) => {
  const time = getSeekTime(event);
  seek.style.setProperty("--hover", `${(time / duration) * 100}%`);
  seekTooltip.textContent = formatTime(time);
  if (dragging) {
    setCurrentTime(time);
  }
});
for (const eventName of ["pointerup", "pointercancel"]) {
  seek.addEventListener(eventName, () => {
    dragging = false;
    seek.dataset.dragging = "false";
  });
}
seek.addEventListener("keydown", (event) => {
  const steps = { ArrowLeft: -SEEK_STEP, ArrowRight: SEEK_STEP, PageDown: -60, PageUp: 60 };
  if (event.key in steps) {
    event.preventDefault();
    event.stopPropagation();
    setCurrentTime(deck.currentTime + steps[event.key]);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    setCurrentTime(event.key === "Home" ? 0 : duration);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target;
  if (target.matches?.("input, textarea") || (target.matches?.("button, a") && (event.key === " " || event.key === "Enter"))) {
    return;
  }
  const actions = {
    " ": togglePlay,
    k: togglePlay,
    ArrowLeft: () => setCurrentTime(deck.currentTime - SEEK_STEP),
    ArrowRight: () => setCurrentTime(deck.currentTime + SEEK_STEP),
    ArrowUp: () => (deck.volume = Math.min(1, deck.volume + VOLUME_STEP)),
    ArrowDown: () => (deck.volume = Math.max(0, deck.volume - VOLUME_STEP)),
    m: () => muteButton.click(),
    f: () => started && toggleFullscreen(),
  };
  const action = actions[event.key];
  if (action) {
    event.preventDefault();
    action();
    setIdleTimer();
  }
});

const storedVolume = getStoredVolume();
if (storedVolume) {
  deck.volume = storedVolume.volume;
  deck.muted = storedVolume.muted;
}
updateVolume();

if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
  deck.requestVideoFrameCallback(onDeckFrame);
}

new ResizeObserver(setScreenSize).observe(slot);

leds
  .load()
  .then(() => {
    const { width, height, channels } = leds.manifest;
    renderer = new PanelRenderer(panelCanvas, width, height, channels);
    setScreenSize();
  })
  .catch((error) => console.error(error));

requestAnimationFrame(update);
