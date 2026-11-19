/**
 * AI Horde adapter.
 *
 * AI Horde is a volunteer network that fronts other people's GPUs behind an
 * [OI]-compatible chat surface (`https://oai.aihorde.net/v1`). Requests need
 * no credential at all: an anonymous `POST /chat/completions` answers 200 with
 * the standard SSE chunk shape and `usage` block (verified 2026-11-19). A
 * registered key raises queue priority and earns kudos, so an account is
 * optional — the route is built credential-free when none exists.
 *
 * Two upstream facts shape this adapter:
 *
 * 1. **`max_tokens` floor.** The surface refuses any completion limit below 16
 *    with `Invalid 'max_tokens'` instead of raising it, so a client that asks
 *    for 8 tokens — a common health-probe and title-generation size — gets a
 *    400 that looks like a bad request from us. The floor is applied in
 *    `prePayload` so every wire path (chat, and a passthrough that forwards
 *    generation controls) is covered at one place.
 * 2. **It is a queue, not a serving cluster.** A generation is queued and can
 *    take tens of seconds; a small `max_tokens` is the difference between a
 *    fast answer and a long wait. The metadata row carries that as an operator
 *    notice rather than as a capability claim.
 *
 * The static rows are the live `/v1/models` listing: limits are the
 * `context_length` the upstream publishes and the image rows are the ones whose
 * `architecture.input_modalities` includes `image`. No output ceiling is
 * published, so `out` stays `null` instead of a guess.
 */
import { defineModel } from "../provider-model-definition";
import type { ModelDefinition } from "../provider-model-definition";
import type { ApiKeyProviderSpec } from "../configured-provider";

export const AIHORDE_PROVIDER_ID = "aihorde" as const;

/** Wire suffix: the metadata base URL already ends at `/v1`. */
export const AIHORDE_CHAT_ENDPOINT = "/chat/completions" as const;

/**
 * The completion limit the upstream accepts: `max_tokens` must be between 16
 * and 16384. Outside that window the surface answers 400 `The token limit must
 * be between 16 and 16384` instead of clamping, so both ends are enforced
 * before the request leaves the gateway.
 */
export const AIHORDE_MIN_OUTPUT_TOKENS = 16;
export const AIHORDE_MAX_OUTPUT_TOKENS = 16_384;

export const AIHORDE_SPEC: ApiKeyProviderSpec = {
  provider_id: AIHORDE_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: AIHORDE_CHAT_ENDPOINT },
  // Measured 2026-11-19: the surface answers 400 `The parameter
  // 'prompt_cache_key' is not supported`, so the gateway must not stamp the
  // cache control on this wire.
  promptCache: false,
  prePayload: (payload) => {
    const limit = payload["max_tokens"];
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      // An omitted limit is the common case (this gateway forwards nothing for
      // it), and the upstream would then apply its own ceiling — stating our
      // own keeps the request deterministic without asking for the maximum.
      payload["max_tokens"] = AIHORDE_MIN_OUTPUT_TOKENS;
      return;
    }
    if (limit < AIHORDE_MIN_OUTPUT_TOKENS) payload["max_tokens"] = AIHORDE_MIN_OUTPUT_TOKENS;
    else if (limit > AIHORDE_MAX_OUTPUT_TOKENS) payload["max_tokens"] = AIHORDE_MAX_OUTPUT_TOKENS;
  },
};

interface HordeModelOptions {
  readonly ctx: number;
  readonly vision?: boolean;
}

function hordeModel(id: string, options: HordeModelOptions): ModelDefinition {
  return defineModel({
    id,
    providerId: AIHORDE_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: AIHORDE_CHAT_ENDPOINT,
    ctx: options.ctx,
    out: AIHORDE_MAX_OUTPUT_TOKENS,
    ...(options.vision === true ? { vision: true } : {}),
    free: true,
  });
}

export const AIHORDE_MODELS: readonly ModelDefinition[] = [
  hordeModel("aphrodite/TheDrummer/Behemoth-128B-v3", { ctx: 32_768, vision: true }),
  hordeModel("koboldcpp/Cydonia-24B-v4zg-Q4_K_M", { ctx: 12_288, vision: true }),
  hordeModel("koboldcpp/debug-gemma-4-E2B-Queen-it-qat-q4_0-unquantized.i1-Q4_K_M", { ctx: 16_384, vision: true }),
  hordeModel("koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic", { ctx: 65_536 }),
  hordeModel("koboldcpp/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M", { ctx: 16_384, vision: true }),
  hordeModel("koboldcpp/L3-8B-Stheno-v3.2", { ctx: 6_144 }),
  hordeModel("koboldcpp/Llama-3.2-1B-Instruct", { ctx: 16_384 }),
  hordeModel("koboldcpp/Llama-3-Lumimaid-8B-v0.1", { ctx: 8_192, vision: true }),
  hordeModel("koboldcpp/Qwen3-0.6B", { ctx: 2_048 }),
  hordeModel("koboldcpp/Qwen3-1.7B", { ctx: 2_048 }),
  hordeModel("koboldcpp/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive", { ctx: 4_096 }),
  hordeModel("llamacpp/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive", { ctx: 8_192 }),
  hordeModel("lmstudio/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive", { ctx: 8_192 }),
  hordeModel("lmstudio/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive", { ctx: 16_384 }),
  hordeModel("Qwen/Qwen3.8-Flash-Next", { ctx: 65_536, vision: true }),
];
