/**
 * OVHcloud AI Endpoints adapter.
 *
 * OVH publishes an [OI]-compatible surface at
 * `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`. Unlike every other
 * bundled provider it serves that surface to **anonymous callers**: a request
 * with no `Authorization` header answers 200 for the chat models in the
 * listing (verified 2026-11-19 against `Qwen3.5-397B-A17B`,
 * `DeepSeek-V4.1-Flash-1017`, `gpt-oss-120b`, `Meta-Llama-3_3-70B-Instruct`
 * and `nemotron3-nano-30b`).
 *
 * The anonymous allowance is keyed on the **egress address, per model** — two
 * requests pass and the next answers 429 (measured, see the metadata row's
 * `ipScopedRateLimit`), which is why a pool rotation is what recovers a
 * throttled call rather than an account cooldown. An API key lifts the ceiling
 * to ~400 RPM and bills per token, so an account is optional, not required: the
 * route is built credential-free when no account exists and forwards the key
 * when one does.
 *
 * The static rows below are the chat subset of the live `/v1/models` listing
 * (whisper, TTS, Stable Diffusion and the embedding models are excluded — they
 * are not chat wires). Context windows come from that listing; the listing
 * publishes no output ceiling, so `out` is stated as `null` rather than
 * guessed.
 */
import { defineModel } from "../provider-model-definition";
import type { ModelDefinition } from "../provider-model-definition";
import type { ApiKeyProviderSpec } from "../configured-provider";

export const OVHCLOUD_PROVIDER_ID = "ovhcloud" as const;

/** Wire suffix: the metadata base URL already ends at `/v1`. */
export const OVHCLOUD_CHAT_ENDPOINT = "/chat/completions" as const;

export const OVHCLOUD_SPEC: ApiKeyProviderSpec = {
  provider_id: OVHCLOUD_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: OVHCLOUD_CHAT_ENDPOINT },
  // Measured 2026-11-19: the surface answers 400 `feature 'prompt_cache_key'
  // is not currently supported` for a chat request that carries the cache
  // control, so the gateway must not stamp it here.
  promptCache: false,
};

interface OvhModelOptions {
  readonly ctx: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
}

function ovhModel(id: string, options: OvhModelOptions): ModelDefinition {
  return defineModel({
    id,
    providerId: OVHCLOUD_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: OVHCLOUD_CHAT_ENDPOINT,
    ctx: options.ctx,
    out: null,
    ...(options.vision === true ? { vision: true } : {}),
    ...(options.reasoning === true ? { reasoning: true } : {}),
  });
}

export const OVHCLOUD_MODELS: readonly ModelDefinition[] = [
  // Reasoning deltas were observed on the wire for the Qwen 3.5/3.6 family,
  // DeepSeek V4.1 Flash and both gpt-oss sizes; the remaining rows are marked
  // non-reasoning rather than assumed.
  ovhModel("Qwen3.5-397B-A17B", { ctx: 262_144, reasoning: true }),
  ovhModel("DeepSeek-V4.1-Flash-1017", { ctx: 1_048_576, reasoning: true }),
  ovhModel("Qwen3.6-27B", { ctx: 262_144, reasoning: true }),
  ovhModel("Qwen3.8-27B", { ctx: 262_144, reasoning: true }),
  ovhModel("Qwen3.5-9B", { ctx: 262_144, reasoning: true }),
  ovhModel("qwen3.6-35b-a3b", { ctx: 262_144, reasoning: true }),
  ovhModel("gemma-4-26b-a4b", { ctx: 262_144 }),
  ovhModel("nemotron3-nano-30b", { ctx: 262_144, reasoning: true }),
  ovhModel("nemotron3-omni-30b", { ctx: 131_072, reasoning: true }),
  ovhModel("gpt-oss-120b", { ctx: 131_072, reasoning: true }),
  ovhModel("gpt-oss-20b", { ctx: 131_072, reasoning: true }),
  ovhModel("Meta-Llama-3_3-70B-Instruct", { ctx: 131_072 }),
  ovhModel("Mistral-Small-3.2-24B-Instruct-2506", { ctx: 131_072 }),
  ovhModel("laguna-xs-2.1", { ctx: 131_072 }),
  ovhModel("qwen3-vl-30b-a3b", { ctx: 32_768, vision: true, reasoning: true }),
  ovhModel("Qwen2.5-VL-72B-Instruct", { ctx: 32_768, vision: true }),
  ovhModel("clef-flash", { ctx: 16_384 }),
  ovhModel("Olala-v1.0-mini-7A1B", { ctx: 32_768 }),
  ovhModel("Olala-v1.0-translate", { ctx: 8_192 }),
  ovhModel("Olala-v1.0-summarise", { ctx: 32_768 }),
  // `solaria-3` reports `context_length: 0` upstream, i.e. no published
  // window. Passing `0` would advertise an unusable context, so the row keeps
  // the catalog's own resolution instead of an invented number.
  defineModel({
    id: "solaria-3",
    providerId: OVHCLOUD_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: OVHCLOUD_CHAT_ENDPOINT,
    out: null,
  }),
];
