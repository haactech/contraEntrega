# Prueba local (modo demo, sin dinero real)

## 1. Levantar
```bash
pnpm setup:local   # install + build web + migraciones y seed mock en D1 local + .dev.vars
pnpm dev           # build web + wrangler dev en http://localhost:8787
```
Si el puerto 8787 está ocupado:
```bash
pnpm --filter @trato/web build
cd apps/api && npx wrangler dev --port 8788 --var PUBLIC_APP_URL:http://localhost:8788
```
Todo corre en tu máquina (workerd/Miniflare); D1 y R2 viven en `apps/api/.wrangler/state`.
Para empezar de cero: borra `apps/api/.wrangler/state` y repite `pnpm setup:local`.

## 2. Dos "dispositivos" en un mismo navegador
- **Prestador:** `http://localhost:<puerto>`
- **Comprador:** abre el enlace compartido cambiando `localhost` por `127.0.0.1` (otro origen = sin la cookie del prestador). También sirve una ventana de incógnito.
  Si abres el enlace con la sesión del prestador dueño, aceptar/aprobar responde 403 (el vendedor no puede aprobar su propia entrega).

PIN demo: el valor de `DEMO_SELLER_PIN` en `apps/api/.dev.vars`.

## 3. Recorrido (qué debes ver)
| # | Quién | Acción | Resultado esperado |
|---|---|---|---|
| 1 | Prestador | Elegir perfil + PIN | Lista de tratos, banner «MODO DEMO» |
| 2 | Prestador | Nuevo trato → total, preset 30 % → «Crear y compartir» | Hoja con enlace y botón WhatsApp |
| 3 | Comprador | Abrir enlace, nombre + consentimiento → «Aceptar acuerdo» | «Acuerdo aceptado» (no es un pago); aparece «Pagar anticipo» |
| 4 | Comprador | «Pagar anticipo con QR» | QR, monto, referencia, vencimiento 24 h |
| 5 | Comprador | «Simular pago (demo)» | «Anticipo recibido»; historial lo registra |
| 6 | Prestador | Subir 1–3 fotos + nota → «Solicitar revisión» | Paso «Revisión», el comprador ve las fotos |
| 7 | Comprador | «Reportar problema» con motivo | Saldo «Problema reportado»; no hay botón de pagar saldo |
| 8 | Prestador | Ve el motivo → nuevas fotos → «Volver a entregar» | Nueva ronda; historial conserva todo |
| 9 | Comprador | «Recibido, todo bien» → confirmar | Aparece «Pagar saldo» (aprobar ≠ pagar) |
| 10 | Comprador | QR saldo → «Simular pago (demo)» | «Saldo pagado», «Trato completado» |
| 11 | Ambos | «Exportar» | Registro imprimible con términos, SHA-256, pagos, fotos, historial y avisos |

## 4. Modo real con pey (después de validar el demo)
1. `PEY_API_KEY` y `PEY_WEBHOOK_SECRET` en `apps/api/.dev.vars`; `PAYMENTS_MODE=live` (var en `wrangler.jsonc` o `--var PAYMENTS_MODE:live`).
2. `cd apps/api && pnpm register-accounts && pnpm db:seed:accounts:local && pnpm verify-accounts`.
3. Cobros de **$0.01** (los pagos de prueba no se devuelven).
4. pey no puede llamar a `localhost`: la confirmación llega con «Ya pagué, verificar» (consulta a pey). Para probar el webhook real: `cloudflared tunnel --url http://localhost:<puerto>` y registrar `<url>/api/webhooks/pey` en portal.pey.mx.
