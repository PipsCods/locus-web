// OpenAI Responses API, one call with Structured Outputs and no tools.
// Docs checked 2026-11-16:
//   model id + effort values: https://developers.openai.com/api/docs/models/gpt-6.1-terra
//     ("gpt-6.1-terra"; reasoning.effort none|low|medium (default)|high|xhigh|max)
//   reasoning params on GPT-6: https://developers.openai.com/api/docs/guides/latest-model
//     (Responses: reasoning.effort; drop temperature/top_p when effort is not none)
//   structured output: https://developers.openai.com/api/docs/guides/structured-outputs
//     (text.format = { type: "json_schema", name, strict: true, schema })

import { fetchJson } from "./http.js";

export function openaiClient({ apiKey, fetchFn = fetch, timeoutMs = 90_000 }) {
  return {
    /** Returns the parsed JSON object the model produced, or throws. */
    async structured({ model, effort, instructions, input, schemaName, schema, maxOutputTokens }) {
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const body = await fetchJson(fetchFn, "https://api.openai.com/v1/responses", {
        method: "POST",
        timeoutMs,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(responsesRequest({ model, effort, instructions, input, schemaName, schema, maxOutputTokens })),
      });
      return parseStructured(body);
    },
  };
}

export function responsesRequest({ model, effort, instructions, input, schemaName, schema, maxOutputTokens }) {
  return {
    model,
    reasoning: { effort },
    instructions,
    input: [{ role: "user", content: input }],
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    max_output_tokens: maxOutputTokens,
    store: false,
    // no `tools`: the model gets nothing to call
  };
}

/** Pulls the JSON text out of a Responses API body (output[] -> message -> output_text). */
export function parseStructured(body) {
  if (body?.status && body.status !== "completed") throw new Error(`response ${body.status}${body.incomplete_details?.reason ? ": " + body.incomplete_details.reason : ""}`);
  for (const item of body?.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") throw new Error(`model refused: ${String(part.refusal).slice(0, 200)}`);
      if (part.type === "output_text") return JSON.parse(part.text);
    }
  }
  throw new Error("no output_text in response");
}
