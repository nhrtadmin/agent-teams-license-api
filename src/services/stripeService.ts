import Stripe from "stripe";
import { prisma } from "../db";
import { generateLicenseKey, planDays, addDays } from "./licenseService";

export async function handleStripeWebhook(
  rawBody: Buffer,
  sig: string
): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not configured");

  const stripe = new Stripe(stripeKey);
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${String(err)}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const { userId, plan, renewLicenseId } = session.metadata ?? {};

    if (!userId || !plan) {
      console.error("[stripe webhook] Missing metadata in session", session.id);
      return;
    }

    if (renewLicenseId) {
      // Renewal: extend existing license
      const existing = await prisma.license.findFirst({
        where: { id: renewLicenseId, userId },
      });
      if (existing) {
        const base =
          existing.expiresAt && existing.expiresAt > new Date()
            ? existing.expiresAt
            : new Date();
        await prisma.license.update({
          where: { id: renewLicenseId },
          data: {
            status: "active",
            expiresAt: addDays(base, planDays(plan)),
            stripePaymentId: session.payment_intent as string | null,
          },
        });
        console.log(`[stripe] Renewed license ${renewLicenseId}`);
      }
    } else {
      // New purchase: create license
      const key = generateLicenseKey();
      const expiresAt = addDays(new Date(), planDays(plan));
      const license = await prisma.license.create({
        data: {
          key,
          userId,
          plan,
          status: "active",
          expiresAt,
          stripeSessionId: session.id,
          stripePaymentId: session.payment_intent as string | null,
        },
      });
      console.log(`[stripe] Created license ${license.key} for user ${userId}`);
    }
  }
}
