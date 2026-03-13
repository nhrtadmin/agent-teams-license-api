import { prisma } from "../db";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";

const ENCRYPTION_KEY = process.env.API_KEY_ENCRYPTION_KEY;
const ALG = "aes-256-gcm";

function decryptKey(encrypted: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) return encrypted;
  if (!encrypted.includes(":")) return encrypted;
  const parts = encrypted.split(":");
  if (parts.length < 3) return encrypted;
  const [ivHex, tagHex, encHex] = parts;
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(tagHex!, "hex");
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encHex!, "hex", "utf8") + decipher.final("utf8");
}

/** Get an active Anthropic API key (from DB or fallback to env) */
export async function getAnthropicApiKey(): Promise<string> {
  const fromDb = await prisma.llmApiKey.findFirst({
    where: { provider: "anthropic", isActive: true },
    orderBy: { lastUsedAt: "asc" },
  });
  if (fromDb) {
    const key = decryptKey(fromDb.apiKey);
    if (key) {
      await prisma.llmApiKey.update({
        where: { id: fromDb.id },
        data: { lastUsedAt: new Date() },
      });
      return key;
    }
  }
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) return env;
  throw new Error("No Anthropic API key configured. Add keys in Admin panel or set ANTHROPIC_API_KEY.");
}

export function getAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}
