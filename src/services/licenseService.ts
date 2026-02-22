import crypto from "crypto";
import { prisma } from "../db";

export function generateLicenseKey(): string {
  const seg = () => crypto.randomBytes(4).toString("hex").toUpperCase();
  return `AT-${seg()}-${seg()}-${seg()}`;
}

export function daysUntil(date: Date): number {
  const ms = date.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function planDays(plan: string): number {
  return plan === "annual" ? 365 : 30;
}

export interface ValidateResult {
  valid: boolean;
  reason?: "not_found" | "expired" | "machine_mismatch" | "cancelled" | "inactive";
  expiresAt?: string;
  daysLeft?: number;
  plan?: string;
  email?: string;
  licenseId?: string;
}

export async function validateLicense(
  key: string,
  machineId: string
): Promise<ValidateResult> {
  const license = await prisma.license.findUnique({
    where: { key },
    include: { user: { select: { email: true } } },
  });

  if (!license) return { valid: false, reason: "not_found" };
  if (license.status === "cancelled") return { valid: false, reason: "cancelled" };
  if (license.status === "inactive") return { valid: false, reason: "inactive" };

  if (license.expiresAt && license.expiresAt < new Date()) {
    // Auto-mark expired
    await prisma.license.update({
      where: { id: license.id },
      data: { status: "expired" },
    });
    return {
      valid: false,
      reason: "expired",
      expiresAt: license.expiresAt.toISOString(),
      plan: license.plan,
      email: license.user.email,
    };
  }

  if (license.machineId && license.machineId !== machineId) {
    return { valid: false, reason: "machine_mismatch", plan: license.plan };
  }

  // Lock to machine on first validation
  if (!license.machineId) {
    await prisma.license.update({
      where: { id: license.id },
      data: { machineId, activatedAt: license.activatedAt ?? new Date() },
    });
  }

  return {
    valid: true,
    expiresAt: license.expiresAt?.toISOString(),
    daysLeft: license.expiresAt ? daysUntil(license.expiresAt) : undefined,
    plan: license.plan,
    email: license.user.email,
    licenseId: license.id,
  };
}
