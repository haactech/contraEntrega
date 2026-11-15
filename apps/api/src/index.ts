import { Hono } from "hono";
import type { HonoEnv } from "./env";
import { onError, onNotFound } from "./middleware/error";
import { securityHeaders } from "./middleware/security";
import { devRoutes } from "./routes/dev";
import { apiKeyRoutes } from "./routes/api-keys";
import { agreementRoutes } from "./routes/agreements";
import { conversationRoutes } from "./routes/conversations";
import { fileRoutes } from "./routes/files";
import { publicRoutes } from "./routes/public";
import { systemRoutes } from "./routes/system";
import { webhookRoutes } from "./routes/webhooks";

const api = new Hono<HonoEnv>();
api.use("*", securityHeaders);
api.route("/", systemRoutes);
api.route("/agreements", agreementRoutes);
api.route("/api-keys", apiKeyRoutes);
api.route("/conversations", conversationRoutes);
api.route("/public", publicRoutes);
api.route("/files", fileRoutes);
api.route("/webhooks", webhookRoutes);
api.route("/dev", devRoutes);

const app = new Hono<HonoEnv>();
app.route("/api", api);
app.onError(onError);
app.notFound(onNotFound);

export default app;
