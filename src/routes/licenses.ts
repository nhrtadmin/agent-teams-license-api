import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, type AuthRequest } from "../middleware/authMiddleware";
import {
  validateLicense,
  generateLicenseKey,
  planDays,
  addDays,
  daysUntil,
} from "../services/licenseService";
import Stripe from "stripe";

const router = Router();

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

// GET /licenses/validate?key=AT-...&machineId=...
router.get("/validate", async (req, res) => {
  try {
    const { key, machineId } = req.query as {
      key?: string;
      machineId?: string;
    };

    if (!key || !machineId) {
      res.status(400).json({ valid: false, reason: "missing_params" });
      return;
    }

    const result = await validateLicense(key, machineId);
    res.json(result);
  } catch (err) {
    console.error("[licenses/validate]", err);
    res.status(500).json({ valid: false, reason: "server_error" });
  }
});

// POST /licenses/activate  { key, machineId }
router.post("/activate", async (req, res) => {
  try {
    const { key, machineId } = req.body as {
      key?: string;
      machineId?: string;
    };

    if (!key || !machineId) {
      res.status(400).json({ error: "key and machineId are required" });
      return;
    }

    const result = await validateLicense(key, machineId);
    if (!result.valid) {
      res.status(422).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error("[licenses/activate]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /licenses  — list my licenses (requires JWT)
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const licenses = await prisma.license.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
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
    });
    res.json({ licenses });
  } catch (err) {
    console.error("[licenses/list]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /licenses/checkout  { plan: "monthly" | "annual" }
router.post("/checkout", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { plan } = req.body as { plan?: string };
    if (!plan || !["monthly", "annual"].includes(plan)) {
      res.status(400).json({ error: "plan must be 'monthly' or 'annual'" });
      return;
    }

    const stripe = getStripe();
    const priceId =
      plan === "annual"
        ? process.env.STRIPE_ANNUAL_PRICE_ID
        : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId) {
      res.status(500).json({ error: "Stripe price IDs not configured" });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.PORTAL_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.PORTAL_CANCEL_URL,
      metadata: { userId: req.userId!, plan },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[licenses/checkout]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /licenses/renew  { licenseId }  — create new Stripe session to extend
router.post("/renew", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { licenseId } = req.body as { licenseId?: string };
    if (!licenseId) {
      res.status(400).json({ error: "licenseId is required" });
      return;
    }

    const license = await prisma.license.findFirst({
      where: { id: licenseId, userId: req.userId },
    });
    if (!license) {
      res.status(404).json({ error: "License not found" });
      return;
    }

    const stripe = getStripe();
    const priceId =
      license.plan === "annual"
        ? process.env.STRIPE_ANNUAL_PRICE_ID
        : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId) {
      res.status(500).json({ error: "Stripe price IDs not configured" });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.PORTAL_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}&renew=1`,
      cancel_url: process.env.PORTAL_CANCEL_URL,
      metadata: { userId: req.userId!, plan: license.plan, renewLicenseId: licenseId },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[licenses/renew]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /licenses/demo  — create an instant demo license (no Stripe, monthly plan)
router.post("/demo", requireAuth, async (req: AuthRequest, res) => {
  try {
    const key = generateLicenseKey();
    const expiresAt = addDays(new Date(), planDays("monthly"));
    const license = await prisma.license.create({
      data: {
        key,
        userId: req.userId!,
        plan: "monthly",
        status: "active",
        activatedAt: new Date(),
        expiresAt,
      },
      select: {
        id: true,
        key: true,
        plan: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    res.status(201).json({ license });
  } catch (err) {
    console.error("[licenses/demo]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /licenses/session/:sessionId — get license created after Stripe payment
router.get("/session/:sessionId", requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = req.params["sessionId"] as string;
    const license = await prisma.license.findFirst({
      where: { stripeSessionId: sessionId, userId: req.userId },
      select: {
        id: true,
        key: true,
        plan: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    if (!license) {
      // Might still be processing — return 202
      res.status(202).json({ message: "License not yet created, retry shortly" });
      return;
    }

    res.json({ license });
  } catch (err) {
    console.error("[licenses/session]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
