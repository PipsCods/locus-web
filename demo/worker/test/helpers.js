// Shared test wiring.
import { env } from "cloudflare:workers";

export const SECRET = "test-secret-test-secret-test-secret-0123";

export async function resetDb() {
  await env.DB.exec("DELETE FROM demos; DELETE FROM used_tokens;");
}
