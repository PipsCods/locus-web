import { describe, it, expect } from "vitest";
import { openaiClient, responsesRequest, parseStructured } from "../src/clients/openai.js";
import { SCHEMA } from "../src/decide.js";

describe("OpenAI Responses client", () => {
  it("builds the documented request: reasoning.effort, text.format json_schema strict, no tools", async () => {
    let sent;
    const fetchFn = async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return Response.json({ status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: '{"decision":"review","reason":"thin"}' }] }] });
    };
    const out = await openaiClient({ apiKey: "sk-test", fetchFn }).structured({ model: "gpt-6.1-terra", effort: "medium", instructions: "sys", input: "data", schemaName: "demo_screening", schema: SCHEMA, maxOutputTokens: 4000 });
    expect(out).toEqual({ decision: "review", reason: "thin" });
    expect(sent.url).toBe("https://api.openai.com/v1/responses");
    expect(sent.init.headers.authorization).toBe("Bearer sk-test");
    expect(sent.body).toEqual({
      model: "gpt-6.1-terra",
      reasoning: { effort: "medium" },
      instructions: "sys",
      input: [{ role: "user", content: "data" }],
      text: { format: { type: "json_schema", name: "demo_screening", strict: true, schema: SCHEMA } },
      max_output_tokens: 4000,
      store: false,
    });
    expect(sent.body.tools).toBeUndefined();
    expect(sent.body.temperature).toBeUndefined();
  });

  it("treats refusals, incomplete responses and HTTP errors as errors", async () => {
    expect(() => parseStructured({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).toThrow(/refused/);
    expect(() => parseStructured({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toThrow(/incomplete/);
    const c = openaiClient({ apiKey: "k", fetchFn: async () => new Response("{}", { status: 500 }) });
    await expect(c.structured(responsesRequest({}))).rejects.toThrow(/500/);
  });
});
