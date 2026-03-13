import { Router, Request, Response } from "express";
import { validateLicense, checkTokenLimit, recordUsage } from "../services/licenseService";
import { getAnthropicApiKey, getAnthropicClient } from "../services/llmService";

const router = Router();

interface StreamBody {
  licenseKey: string;
  machineId: string;
  model: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

interface CompleteBody {
  licenseKey: string;
  machineId: string;
  model: string;
  maxTokens?: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

function requireLicense(
  req: Request,
  body: { licenseKey?: string; machineId?: string }
): { valid: true; licenseId: string } | { valid: false; status: number; body: object } {
  const { licenseKey, machineId } = body;
  if (!licenseKey || !machineId) {
    return { valid: false, status: 400, body: { error: "licenseKey and machineId are required" } };
  }
  // Validation is async; callers use validateLicense
  return { valid: true, licenseId: "" };
}

/**
 * POST /llm/stream
 * Proxies streaming LLM requests to Anthropic. Validates license first.
 * Request body: { licenseKey, machineId, model, systemPrompt, messages }
 * Response: NDJSON stream - { delta: string } per token, { done: true, inputTokens?, outputTokens? } at end
 */
router.post("/stream", async (req: Request, res: Response) => {
  try {
    const body = req.body as StreamBody;
    const check = requireLicense(req, body);
    if (!check.valid) {
      res.status(check.status).json(check.body);
      return;
    }

    const validation = await validateLicense(body.licenseKey, body.machineId);
    if (!validation.valid) {
      res.status(403).json({
        error: "license_invalid",
        reason: validation.reason ?? "invalid",
      });
      return;
    }
    const limitCheck = await checkTokenLimit(validation.licenseId!);
    if (!limitCheck.allowed) {
      res.status(403).json({
        error: "token_limit_exceeded",
        used: limitCheck.used,
        limit: limitCheck.limit,
      });
      return;
    }

    const apiKey = await getAnthropicApiKey();
    const client = getAnthropicClient(apiKey);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const stream = client.messages.stream({
      model: body.model,
      max_tokens: 16000,
      system: body.systemPrompt,
      messages: body.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    stream.on("text", (delta: string) => {
      res.write(JSON.stringify({ delta }) + "\n");
    });

    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    if (validation.licenseId && validation.userId && (inputTokens > 0 || outputTokens > 0)) {
      recordUsage(validation.licenseId, validation.userId, inputTokens, outputTokens, body.model).catch((e) =>
        console.error("[llm/stream] recordUsage:", e)
      );
    }
    res.write(
      JSON.stringify({
        done: true,
        inputTokens,
        outputTokens,
      }) + "\n"
    );
    res.end();
  } catch (err) {
    console.error("[llm/stream]", err);
    const message = err instanceof Error ? err.message : String(err);
    const isAuth = message.toLowerCase().includes("auth") || message.includes("401");
    const isRateLimit = message.toLowerCase().includes("rate") || message.includes("429");
    res.status(isAuth ? 401 : isRateLimit ? 429 : 500).json({
      error: isAuth ? "invalid_api_key" : isRateLimit ? "rate_limit" : "server_error",
      message,
    });
  }
});

/**
 * POST /llm/complete
 * Non-streaming completion for tool runs (e.g. PPTX design).
 * Request body: { licenseKey, machineId, model, maxTokens?, messages }
 * Response: { content: string, usage?: { inputTokens, outputTokens } }
 */
router.post("/complete", async (req: Request, res: Response) => {
  try {
    const body = req.body as CompleteBody;
    const check = requireLicense(req, body);
    if (!check.valid) {
      res.status(check.status).json(check.body);
      return;
    }

    const validation = await validateLicense(body.licenseKey, body.machineId);
    if (!validation.valid) {
      res.status(403).json({
        error: "license_invalid",
        reason: validation.reason ?? "invalid",
      });
      return;
    }
    const limitCheck = await checkTokenLimit(validation.licenseId!);
    if (!limitCheck.allowed) {
      res.status(403).json({
        error: "token_limit_exceeded",
        used: limitCheck.used,
        limit: limitCheck.limit,
      });
      return;
    }

    const apiKey = await getAnthropicApiKey();
    const client = getAnthropicClient(apiKey);
    const msg = await client.messages.create({
      model: body.model,
      max_tokens: body.maxTokens ?? 4096,
      messages: body.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    const text =
      msg.content[0]?.type === "text" ? (msg.content[0] as { text: string }).text : "";
    const usage = msg.usage;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    if (validation.licenseId && validation.userId && (inputTokens > 0 || outputTokens > 0)) {
      recordUsage(validation.licenseId, validation.userId, inputTokens, outputTokens, body.model).catch((e) =>
        console.error("[llm/complete] recordUsage:", e)
      );
    }

    res.json({
      content: text,
      usage: usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
    });
  } catch (err) {
    console.error("[llm/complete]", err);
    const message = err instanceof Error ? err.message : String(err);
    const isAuth = message.toLowerCase().includes("auth") || message.includes("401");
    const isRateLimit = message.toLowerCase().includes("rate") || message.includes("429");
    res.status(isAuth ? 401 : isRateLimit ? 429 : 500).json({
      error: isAuth ? "invalid_api_key" : isRateLimit ? "rate_limit" : "server_error",
      message,
    });
  }
});

/**
 * POST /llm/test
 * Validates license and tests connectivity to Anthropic (for desktop "test connection").
 * Request body: { licenseKey, machineId }
 * Response: { success: boolean, error?: string }
 */
router.post("/test", async (req: Request, res: Response) => {
  try {
    const { licenseKey, machineId } = req.body as { licenseKey?: string; machineId?: string };
    if (!licenseKey || !machineId) {
      res.status(400).json({ success: false, error: "licenseKey and machineId required" });
      return;
    }

    const validation = await validateLicense(licenseKey, machineId);
    if (!validation.valid) {
      res.status(403).json({
        success: false,
        error: `License invalid: ${validation.reason ?? "invalid"}`,
      });
      return;
    }

    const apiKey = await getAnthropicApiKey();
    const client = getAnthropicClient(apiKey);
    await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error =
      message.toLowerCase().includes("auth") || message.includes("401")
        ? "Invalid API key"
        : message.toLowerCase().includes("rate") || message.includes("429")
          ? "Rate limit exceeded"
          : message.toLowerCase().includes("network") || message.toLowerCase().includes("fetch")
            ? "Network error"
            : message || "Connection failed";
    res.json({ success: false, error });
  }
});

export default router;
