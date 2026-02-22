import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import licenseRoutes from "./routes/licenses";
import stripeRoutes from "./routes/stripe";

const app = express();
const PORT = process.env.PORT ?? 4000;

// Stripe webhook needs raw body — mount BEFORE json middleware
app.use("/stripe", stripeRoutes);

app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*", credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/auth", authRoutes);
app.use("/licenses", licenseRoutes);

app.listen(PORT, () => {
  console.log(`License API running on http://localhost:${PORT}`);
});

export default app;
