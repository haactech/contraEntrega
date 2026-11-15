import { Hono } from "hono";
import type { HonoEnv } from "./env";
import { onError, onNotFound } from "./middleware/error";
import { securityHeaders } from "./middleware/security";
import { agreementRoutes } from "./routes/agreements";
import { publicRoutes } from "./routes/public";
import { systemRoutes } from "./routes/system";

const api = new Hono<HonoEnv>();
api.use("*", securityHeaders);
api.route("/", systemRoutes);
api.route("/agreements", agreementRoutes);
api.route("/public", publicRoutes);

const app = new Hono<HonoEnv>();
app.route("/api", api);
app.onError(onError);
app.notFound(onNotFound);

export default app;
