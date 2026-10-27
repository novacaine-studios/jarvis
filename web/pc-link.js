// When this page is opened from the Jarvis server on your PC (by scanning its QR code), the PC does the
// listening and thinking, so nothing big has to load in Safari. This file stands in for the two workers:
// it offers the same postMessage / "message" interface, and carries everything over one WebSocket.

export const pcKey = new URLSearchParams(location.search).get("key");

class Channel extends EventTarget {
  constructor(link, name) {
    super();
    this.link = link;
    this.name = name;
  }

  postMessage(data) {
    this.link.send(this.name, data);
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/** Camera frames go to the PC as JPEG, which is far smaller than raw pixels. */
async function toJpeg({ pixels, width, height }) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const url = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

export class PcLink {
  /** onStatus(text) shows the connection state; onConnect() runs after every (re)connection. */
  constructor({ onStatus, onConnect }) {
    this.onStatus = onStatus;
    this.onConnect = onConnect;
    this.ears = new Channel(this, "ears");
    this.brain = new Channel(this, "brain");
    this.socket = null;
    this.connect();
  }

  connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws?key=${encodeURIComponent(pcKey)}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.onStatus("Connecting to your PC…");
    socket.addEventListener("open", () => {
      this.onStatus("");
      this.onConnect();
    });
    socket.addEventListener("message", ({ data }) => {
      const { ch, ...message } = JSON.parse(data);
      (ch === "ears" ? this.ears : this.brain).receive(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      // Questions in flight won't be answered now.
      this.brain.dispatchEvent(new Event("error"));
      this.onStatus("Lost touch with your PC. Is Jarvis still running there? Reconnecting…");
      setTimeout(() => this.connect(), 2000);
    });
  }

  get open() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async send(channel, data) {
    if (channel === "ears" && data.type === "audio") {
      if (!this.open) return;
      // 16-bit samples: half the size of the floats the microphone gives us.
      const samples = new Int16Array(data.chunk.length);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, data.chunk[i])) * 0x7fff;
      this.socket.send(samples.buffer);
      return;
    }
    let message = data;
    if (channel === "brain" && data.type === "vision") {
      const { pixels, width, height, ...rest } = data;
      message = { ...rest, image: await toJpeg({ pixels, width, height }) };
    }
    if (this.open) this.socket.send(JSON.stringify({ ch: channel, ...message }));
    else if (channel === "brain") this.brain.receive({ id: data.id, ok: false, error: "I can't reach your PC" });
  }
}
