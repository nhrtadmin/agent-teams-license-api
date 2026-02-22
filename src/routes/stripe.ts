import { Router } from "express";
import express from "express";
import { handleStripeWebhook } from "../services/stripeService";

const router = Router();

// Stripe requires the raw body — use express.raw() here
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    try {
      await handleStripeWebhook(req.body as Buffer, sig);
      res.json({ received: true });
    } catch (err) {
      console.error("[stripe/webhook]", err);
      res.status(400).json({ error: String(err) });
    }
  }
);

export default router;
