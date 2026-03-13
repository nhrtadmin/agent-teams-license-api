import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import crypto from "crypto";

const router = Router();
const ENCRYPTION_KEY = process.env.API_KEY_ENCRYPTION_KEY; // 32 bytes hex
const ALG = "aes-256-gcm";

function encryptKey(plain: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) {
    return plain; // fallback: store as-is if no key (dev only)
  }
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + authTag.toString("hex") + ":" + enc.toString("hex");
}

function decryptKey(encrypted: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) return encrypted;
  if (!encrypted.includes(":")) return encrypted;
  const [ivHex, tagHex, encHex] = encrypted.split(":");
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(tagHex!, "hex");
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encHex!, "hex", "utf8") + decipher.final("utf8");
}

// All admin routes require auth + admin role
router.use(requireAuth);
router.use(requireAdmin);

// GET /admin/users/usage - usage reports per user
router.get("/users/usage", async (_req, res) => {
  try {
    const usages = await prisma.licenseUsage.groupBy({
      by: ["userId"],
      _sum: { inputTokens: true, outputTokens: true },
      _count: { id: true },
    });
    const userIds = usages.map((u) => u.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const result = usages.map((u) => ({
      userId: u.userId,
      email: userMap.get(u.userId)?.email ?? "—",
      name: userMap.get(u.userId)?.name ?? null,
      totalInputTokens: u._sum.inputTokens ?? 0,
      totalOutputTokens: u._sum.outputTokens ?? 0,
      totalTokens: (u._sum.inputTokens ?? 0) + (u._sum.outputTokens ?? 0),
      requestCount: u._count.id,
    }));
    res.json({ usages: result });
  } catch (err) {
    console.error("[admin/users/usage]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/usage/by-license - usage per license
router.get("/usage/by-license", async (_req, res) => {
  try {
    const usages = await prisma.licenseUsage.groupBy({
      by: ["licenseId", "userId"],
      _sum: { inputTokens: true, outputTokens: true },
      _count: { id: true },
    });
    const licenseIds = [...new Set(usages.map((u) => u.licenseId))];
    const licenses = await prisma.license.findMany({
      where: { id: { in: licenseIds } },
      include: { user: { select: { email: true, name: true } } },
    });
    const licMap = new Map(licenses.map((l) => [l.id, l]));
    const result = usages.map((u) => {
      const lic = licMap.get(u.licenseId);
      return {
        licenseId: u.licenseId,
        licenseKey: lic ? `${lic.key.slice(0, 10)}...` : "—",
        userId: u.userId,
        email: lic?.user.email ?? "—",
        totalInputTokens: u._sum.inputTokens ?? 0,
        totalOutputTokens: u._sum.outputTokens ?? 0,
        totalTokens: (u._sum.inputTokens ?? 0) + (u._sum.outputTokens ?? 0),
        requestCount: u._count.id,
      };
    });
    res.json({ usages: result });
  } catch (err) {
    console.error("[admin/usage/by-license]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/usage/recent - recent usage records
router.get("/usage/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const rows = await prisma.licenseUsage.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        license: { select: { key: true } },
        user: { select: { email: true } },
      },
    });
    res.json({
      usages: rows.map((r) => ({
        id: r.id,
        licenseKey: r.license.key ? `${r.license.key.slice(0, 10)}...` : "—",
        email: r.user.email,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        model: r.model,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("[admin/usage/recent]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/llm-keys - list API keys (masked)
router.get("/llm-keys", async (_req, res) => {
  try {
    const keys = await prisma.llmApiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, provider: true, isActive: true, lastUsedAt: true, createdAt: true },
    });
    res.json({ keys });
  } catch (err) {
    console.error("[admin/llm-keys]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/llm-keys - add API key
router.post("/llm-keys", async (req, res) => {
  try {
    const { name, apiKey, provider } = req.body as { name?: string; apiKey?: string; provider?: string };
    if (!name || !apiKey) {
      res.status(400).json({ error: "name and apiKey are required" });
      return;
    }
    const encrypted = encryptKey(apiKey.trim());
    const created = await prisma.llmApiKey.create({
      data: { name: name.trim(), apiKey: encrypted, provider: provider ?? "anthropic", isActive: true },
      select: { id: true, name: true, provider: true, isActive: true, createdAt: true },
    });
    res.status(201).json({ key: created });
  } catch (err) {
    console.error("[admin/llm-keys create]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/llm-keys/:id - toggle active or update
router.patch("/llm-keys/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, name } = req.body as { isActive?: boolean; name?: string };
    const update: { isActive?: boolean; name?: string } = {};
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (typeof name === "string") update.name = name.trim();
    const updated = await prisma.llmApiKey.update({
      where: { id },
      data: update,
      select: { id: true, name: true, provider: true, isActive: true, lastUsedAt: true },
    });
    res.json({ key: updated });
  } catch (err) {
    console.error("[admin/llm-keys patch]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /admin/llm-keys/:id
router.delete("/llm-keys/:id", async (req, res) => {
  try {
    await prisma.llmApiKey.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error("[admin/llm-keys delete]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/licenses - list licenses with token limits
router.get("/licenses", async (_req, res) => {
  try {
    const licenses = await prisma.license.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { email: true, name: true } } },
    });
    const licenseIds = licenses.map((l) => l.id);
    const usageSums = await prisma.licenseUsage.groupBy({
      by: ["licenseId"],
      where: { licenseId: { in: licenseIds } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const usageMap = new Map(usageSums.map((u) => [u.licenseId, u]));
    const result = licenses.map((lic) => {
      const u = usageMap.get(lic.id);
      const totalTokens = (u?._sum.inputTokens ?? 0) + (u?._sum.outputTokens ?? 0);
      return {
        id: lic.id,
        key: `${lic.key.slice(0, 8)}...${lic.key.slice(-4)}`,
        plan: lic.plan,
        status: lic.status,
        email: lic.user.email,
        tokenLimit: lic.tokenLimit,
        tokenPeriodDays: lic.tokenPeriodDays,
        usedTokens: totalTokens,
        expiresAt: lic.expiresAt,
        createdAt: lic.createdAt,
      };
    });
    res.json({ licenses: result });
  } catch (err) {
    console.error("[admin/licenses]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/licenses/:id - set token limit
router.patch("/licenses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tokenLimit, tokenPeriodDays } = req.body as { tokenLimit?: number | null; tokenPeriodDays?: number | null };
    const update: { tokenLimit?: number | null; tokenPeriodDays?: number | null } = {};
    if (tokenLimit !== undefined) update.tokenLimit = tokenLimit === null || tokenLimit === 0 ? null : Math.max(0, tokenLimit);
    if (tokenPeriodDays !== undefined) update.tokenPeriodDays = tokenPeriodDays ?? null;
    const updated = await prisma.license.update({
      where: { id },
      data: update,
      select: { id: true, tokenLimit: true, tokenPeriodDays: true },
    });
    res.json({ license: updated });
  } catch (err) {
    console.error("[admin/licenses patch]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Promote user to admin - only existing admins or bootstrap
router.post("/promote", async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    const adminEmails = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (adminEmails.length > 0 && !adminEmails.includes((email ?? "").toLowerCase())) {
      res.status(403).json({ error: "Only pre-configured admin emails can be promoted" });
      return;
    }
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    const user = await prisma.user.update({
      where: { email: email.trim() },
      data: { role: "admin" },
      select: { id: true, email: true, role: true },
    });
    res.json({ user });
  } catch (err) {
    console.error("[admin/promote]", err);
    res.status(500).json({ error: "User not found or already admin" });
  }
});

export default router;
