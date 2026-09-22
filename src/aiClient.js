/*
  aiClient.js - front-end helper for AI chat/vision requests.

  Browsers block direct calls to api.openai.com / api.anthropic.com (CORS), so
  every request goes to our own engine server, which forwards it to the chosen
  provider server-side (no CORS) and returns the plain text answer. The user's
  API key travels to their own engine, never to a third party from the browser.

  In dev the engine is on :5174; in a production build it's the same origin.
*/
const ENGINE_BASE =
  import.meta.env.VITE_ENGINE_BASE ?? (import.meta.env.DEV ? "http://127.0.0.1:5174" : "");

/** Guess the provider from the base URL so a single "provider" field can adapt. */
export function inferProvider(base) {
  const b = String(base || "").toLowerCase();
  if (b.includes("anthropic")) return "anthropic";
  if (b.includes("generativelanguage") || b.includes("googleapis")) return "gemini";
  return "openai";
}

/**
 * Send a chat (and optional image) request through the engine's AI proxy.
 * opts: { provider, base, key, model, system?, prompt, image?, maxTokens?, temperature? }
 * `image` is a base64 JPEG string with no data: prefix.
 * Returns the model's text answer. Throws on any error with a readable message.
 */
export async function callAi(opts) {
  let response;
  try {
    response = await fetch(`${ENGINE_BASE}/api/native/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  } catch {
    throw new Error(
      "Could not reach the engine. Start it with `npm.cmd run engine` (or `npm.cmd run dev:full`), then try again.",
    );
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || `AI request failed (${response.status})`);
  }
  return data.text || "";
}

/**
 * List the model IDs the given key can use (also a connection test).
 * opts: { provider, base, key }. Returns string[] of model IDs.
 */
export async function listModels(opts) {
  let response;
  try {
    response = await fetch(`${ENGINE_BASE}/api/native/ai-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  } catch {
    throw new Error(
      "Could not reach the engine. Start it with `npm.cmd run engine` (or `npm.cmd run dev:full`), then try again.",
    );
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || `Model list failed (${response.status})`);
  }
  return data.models || [];
}
