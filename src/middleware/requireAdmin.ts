import type { Response, NextFunction } from "express";
import { prisma } from "../db";
import type { AuthRequest } from "./authMiddleware";

export async function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { role: true },
  });
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
