# Trato

> Acuerda el trabajo, cobra por etapas y conserva evidencia de todo.

Prototipo de hackatón: acuerdos de dos hitos (anticipo + saldo) entre un prestador y un comprador, cobrados con **CoDi** vía la API de [pey](https://docs.pey.mx). El dinero llega directamente a la cuenta del prestador; **Trato no retiene fondos ni garantiza devoluciones**.

**Demo en vivo:** https://trato.adanhermes23.workers.dev (modo demo: pagos simulados, sin dinero real; PIN `1234`).
Recorridos de prueba: `docs/prueba-local.md` (incluye limpieza por tareas con chat, §3c).

## Estructura

```
apps/api        Cloudflare Worker (Hono) — /api/* + assets de la SPA
apps/web        React + Vite + TypeScript + Tailwind
packages/shared Contratos Zod, enums, máquina de estados
docs/           Especificación (spec-v0.2.md) y OpenAPI de pey
```

## Requisitos

- Node 22 (`.nvmrc`), pnpm 10

## Desarrollo

```bash
pnpm install
pnpm test
pnpm dev:api   # Worker local con D1/R2 en Miniflare
pnpm dev:web   # Vite con proxy a /api
```

Variables locales en `apps/api/.dev.vars` (ver `.dev.vars.example`). Nunca versionar secretos ni CLABEs completas.

## Documentación

- [Especificación v0.2](docs/spec-v0.2.md) — fuente de verdad de la implementación.
- [OpenAPI de pey](docs/pey-openapi.json) — copia de https://docs.pey.mx/openapi.json (14 nov 2026).
