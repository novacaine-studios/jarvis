// Jarvis's brain for the Safari version. Runs entirely in the browser on the iPhone's GPU (WebGPU):
// no account, no API, no cost per question. Models download once from Hugging Face and are cached.
import {
  AutoModelForCausalLM,
  AutoModelForVision2Seq,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";

// Free open-weight models. The text model answers general questions and maths;
// the vision model describes what the camera sees.
const TEXT_MODEL = "onnx-community/Qwen3-0.6B-ONNX";
const VISION_MODEL = "HuggingFaceTB/SmolVLM-256M-Instruct";

const SYSTEM = `You are Jarvis, a helpful voice assistant on the user's iPhone. Address the user as "sir".
Everything you write is read aloud, so answer in plain spoken sentences: no markdown, no lists, no emoji, no LaTeX.
Keep answers to one to three sentences unless asked for detail.
Say maths the way a person would, for example "the integral of x from one to two is three halves".`;

let text = null;
let vision = null;

function progress(which) {
  return (p) => {
    if (p.status === "progress" || p.status === "done") {
      postMessage({ type: "progress", which, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    }
  };
}

function loadText() {
  text ??= Promise.all([
    AutoTokenizer.from_pretrained(TEXT_MODEL, { progress_callback: progress("text") }),
    AutoModelForCausalLM.from_pretrained(TEXT_MODEL, {
      dtype: "q4f16",
      device: "webgpu",
      progress_callback: progress("text"),
    }),
  ]);
  return text;
}

function loadVision() {
  vision ??= Promise.all([
    AutoProcessor.from_pretrained(VISION_MODEL, { progress_callback: progress("vision") }),
    AutoModelForVision2Seq.from_pretrained(VISION_MODEL, {
      dtype: "fp32",
      device: "webgpu",
      progress_callback: progress("vision"),
    }),
  ]);
  return vision;
}

/** Keeps only the new tokens after the prompt and decodes them. */
function decodeNew(tokenizerOrProcessor, sequences, promptLength) {
  const fresh = sequences.slice(null, [promptLength, sequences.dims[1]]);
  return tokenizerOrProcessor.batch_decode(fresh, { skip_special_tokens: true })[0];
}

function forSpeech(reply) {
  // Drop any reasoning the model wrote before its answer, and formatting that sounds odd aloud.
  reply = reply.split("</think>").pop();
  return reply.replace(/<think>[\s\S]*/g, "").replace(/[*#`$_]|\\[()[\]]/g, "").trim();
}

async function askText({ question, history, think }) {
  const [tokenizer, model] = await loadText();
  const messages = [{ role: "system", content: SYSTEM }, ...history, { role: "user", content: question }];
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: think,
  });
  const sequences = await model.generate({
    ...inputs,
    do_sample: true,
    top_k: 20,
    temperature: think ? 0.6 : 0.7,
    max_new_tokens: think ? 1500 : 300,
  });
  return forSpeech(decodeNew(tokenizer, sequences, inputs.input_ids.dims[1]));
}

async function askVision({ question, pixels, width, height }) {
  const [processor, model] = await loadVision();
  const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 4).rgb();
  const messages = [
    {
      role: "user",
      content: [
        { type: "image" },
        { type: "text", text: `${question}\nAnswer in one or two short spoken sentences.` },
      ],
    },
  ];
  const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(prompt, [image], { do_image_splitting: false });
  const sequences = await model.generate({
    ...inputs,
    do_sample: false,
    repetition_penalty: 1.1,
    max_new_tokens: 150,
  });
  return forSpeech(decodeNew(processor, sequences, inputs.input_ids.dims[1]));
}

self.addEventListener("message", async ({ data }) => {
  const { id, type } = data;
  try {
    let result = null;
    if (type === "check") {
      const adapter = await navigator.gpu?.requestAdapter();
      result = Boolean(adapter);
    } else if (type === "load") {
      // Text first so Jarvis can answer sooner; the vision model follows.
      await loadText();
      postMessage({ type: "ready", which: "text" });
      await loadVision();
      postMessage({ type: "ready", which: "vision" });
    } else if (type === "text") {
      result = await askText(data);
    } else if (type === "vision") {
      result = await askVision(data);
    }
    postMessage({ id, ok: true, result });
  } catch (error) {
    postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
});
