import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../db";
import { requireAuth, type AuthRequest } from "../middleware/authMiddleware";

const router = Router();

function signToken(userId: string, email: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign({ userId, email }, secret, {
    expiresIn: (process.env.JWT_EXPIRES_IN ?? "7d") as jwt.SignOptions["expiresIn"],
  });
}

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body as {
      email?: string;
      password?: string;
      name?: string;
    };

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hashed, name: name ?? null },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    const token = signToken(user.id, user.email);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = signToken(user.id, user.email);
    const u = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    const role = (u?.role as string) || "user";
    res.json({
      token,
      user: u ? { ...u, role } : { id: user.id, email: user.email, name: user.name, role: "user", createdAt: user.createdAt },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/bootstrap-admin - first-time: promote a user to admin (no auth required)
// Only works when 0 admins exist. Email must be in ADMIN_EMAILS. Requires BOOTSTRAP_SECRET.
router.post("/bootstrap-admin", async (req, res) => {
  try {
    const { email, secret } = req.body as { email?: string; secret?: string };
    if (process.env.BOOTSTRAP_SECRET && secret !== process.env.BOOTSTRAP_SECRET) {
      res.status(403).json({ error: "Invalid bootstrap secret" });
      return;
    }
    const adminCount = await prisma.user.count({ where: { role: "admin" } });
    if (adminCount > 0) {
      res.status(403).json({ error: "Admin already exists. Use admin panel to promote." });
      return;
    }
    const adminEmails = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (adminEmails.length > 0 && !adminEmails.includes((email ?? "").toLowerCase())) {
      res.status(403).json({ error: "Email not in ADMIN_EMAILS" });
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
    console.error("[auth/bootstrap-admin]", err);
    res.status(500).json({ error: "User not found" });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        licenses: {
          select: {
            id: true,
            key: true,
            plan: true,
            status: true,
            activatedAt: true,
            expiresAt: true,
            machineId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err) {
    console.error("[auth/me]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
