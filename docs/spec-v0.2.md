# Trato — Especificación de implementación v0.2

Fecha: 14 nov 2026 · Base: spec v0.1 · Contrato pey verificado contra `docs/pey-openapi.json` (OpenAPI oficial descargado de https://docs.pey.mx/openapi.json).

Propuesta: «Acuerda el trabajo, cobra por etapas y conserva evidencia de todo».

> Este documento es la **fuente de verdad** para la implementación. Si algo no está aquí, aplica la v0.1 (alcance, no-objetivos, microcopy, riesgos) sin contradecir esta versión.

---

## A. Cambios respecto a v0.1 (y por qué)

| # | Cambio | Motivo |
|---|--------|--------|
| 1 | **Conciliación activa** además del webhook: `POST .../payment-requests/:id/refresh` consulta `GET /transaction/codi/qr/{qrId}` (QR) o `GET /transaction/{transactionId}` (PN). La vista del comprador lo dispara automáticamente con *throttle* (máx. 1 consulta a pey cada 10 s por solicitud). | El webhook puede no llegar (dev en localhost, URL mal configurada, caída). Hace la demo robusta y resuelve el invariante 8 (`CREATION_UNKNOWN`). |
| 2 | **Comparación de importe con comisión**: pey puede reportar `amount` = base + fee/tip (`amountBreakdown`). Regla: concilia si `amount == esperado`, o si `amountBreakdown.base == esperado` (obtenido vía `GET /transaction/{id}` cuando el webhook trae un importe mayor). Cualquier otro caso → `UNMATCHED`. | Evita rechazar pagos legítimos por la comisión al pagador. |
| 3 | **Una sola solicitud activa por hito** (índice único parcial en D1) y **reutilización**: si hay un QR vigente para el hito, se devuelve el mismo en lugar de crear otro. Header opcional `Idempotency-Key`. | Previene doble cobro por doble clic, recargas o dos pestañas, y reduce llamadas a pey. |
| 4 | **Pagos tardíos se acreditan**: un webhook que coincide con una solicitud `EXPIRED_LOCAL`/`CREATION_UNKNOWN` (misma cuenta, importe y `paymentRequestId`) marca el hito `PAID` si aún no estaba pagado. Si el hito ya estaba pagado por otra solicitud → evento `DUPLICATE_PAYMENT_DETECTED` para revisión manual (Trato no reembolsa). | El dinero sí llegó; ignorarlo sería peor. |
| 5 | **Metadata pey regresa como strings**; la correlación compara strings. `numRef` = contador secuencial de 7 dígitos (no es llave única). | Comportamiento documentado en el OpenAPI. |
| 6 | **Un solo Worker** sirve la SPA (Workers Static Assets) y `/api/*`. | Mismo origen → sin CORS, cookies simples, un solo deploy. |
| 7 | **Vista pública única con ETag**: `GET /api/public/tratos/:token` incluye timeline y `version`; responde `304` si no cambió. Polling adaptativo: 3 s mientras hay un pago pendiente, 15 s en otro caso, pausado si la pestaña está oculta. Se elimina `GET /timeline` separado. | Menos peticiones y menos lecturas D1; UI más reactiva justo cuando importa. |
| 8 | **Fotos comprimidas en el cliente** (máx. 1600 px, WebP/JPEG q≈0.8) antes de subir; el re-encode por canvas elimina EXIF. Servidor valida *magic bytes* (JPEG/PNG/WebP), ≤ 5 MB, calcula SHA-256. Lectura vía URL firmada HMAC de corta vida servida por el Worker desde R2. | Subidas rápidas en datos móviles; privacidad (GPS en EXIF); sin credenciales S3. |
| 9 | **Re-entrega tras disputa**: el prestador puede subir nueva evidencia y volver a solicitar revisión (`DISPUTED → WAITING_BUYER_REVIEW`, `delivery_round++`). Todo el historial previo se conserva. | La v0.1 dejaba la disputa como callejón sin salida; esto es la «revisión manual posible». |
| 10 | **Enlace recuperable**: el token se guarda como `token_hash` (búsqueda) **y** `token_ciphertext` (AES-GCM con clave derivada de `SESSION_SECRET`) para que el prestador pueda volver a copiar/compartir el mismo enlace. Nunca en claro. Opción «Regenerar enlace» revoca el anterior. | Usabilidad: el prestador pierde el mensaje de WhatsApp y necesita reenviarlo. |
| 11 | **Aceptación ligada al hash**: el comprador envía `termsSha256` que vio; si no coincide con el sellado → 409. Checkbox de consentimiento obligatorio. | Evita aceptar términos distintos a los mostrados. |
| 12 | **Sesión demo por perfil + PIN**: 5 perfiles de prestador, cada uno ligado a 1 cuenta demo. Login = elegir perfil + `DEMO_SELLER_PIN`. Cookie HMAC `HttpOnly; Secure; SameSite=Lax`, 12 h. El «selector de cuenta» es cambiar de perfil. | Cumple «no dejar formulario libre que permita cobrar a cualquiera» con mínimo esfuerzo. |
| 13 | **Simulador mock que pasa por el pipeline real**: `POST /api/dev/simulate-payment` construye un webhook, lo firma con `PEY_WEBHOOK_SECRET` y lo procesa con el mismo handler. Responde 404 si `PAYMENTS_MODE=live`. Banner «MODO DEMO» visible. | Prueba la firma/idempotencia/conciliación de verdad, sin dinero. |
| 14 | **D1 no tiene transacciones interactivas**: atomicidad con `db.batch([...])`, `UPDATE ... WHERE status = ?` revisando `meta.changes`, y restricciones `UNIQUE`. | Precisión técnica sobre la v0.1 («insertar recibo en transacción»). |
| 15 | **Rate limiting** con el binding *Workers Rate Limiting* en rutas públicas (lecturas 60/min, escrituras 10/min por token+IP). | Implementación nativa y barata. |
| 16 | **PN (push CoDi) incluido** detrás de un campo opcional de teléfono. En resultado ambiguo de PN se exige esperar la expiración (360 s) antes de reintentar, porque el teléfono pudo haber recibido la solicitud. | Es barato con el mismo gateway; el riesgo de doble cobro se controla. |
| 18 | **Alta de cuentas vía `POST /bank-account`** con script local idempotente que guarda el `bankAccountId` devuelto; webhook `bank.account.updated` actualiza `codi_status`. Ver §G. | El ID lo genera pey al registrar; la CLABE nunca toca el Worker ni el repo. |
| 17 | **Código corto humano** por trato (`TR-0007`) usado en `concept` y UI. | El comprador reconoce el cobro en su app bancaria. |

---

## B. Alcance

**P0**: acuerdos de dos hitos (anticipo + saldo), aceptación por enlace, CoDi QR (+ PN opcional), evidencia (1–3 fotos por entrega), aprobación/disputa, re-entrega, cobro de saldo, webhook + conciliación, historial, export imprimible, modo mock.

**No construir**: escrow/custodia, reembolsos, transferencias salientes, arbitraje, IA, suscripciones, marketplace, firma electrónica avanzada, app nativa, WhatsApp Business API (se usa `https://wa.me/?text=`).

**Mensaje obligatorio en UI**: «El dinero llega directamente al prestador. Esta plataforma no retiene fondos ni garantiza devoluciones.»

---

## C. Arquitectura

```
apps/
  api/      Hono en Cloudflare Worker; sirve /api/* y los assets de apps/web/dist
  web/      React + Vite + TS + Tailwind (componentes estilo shadcn/ui)
packages/
  shared/   Zod schemas (contratos HTTP), enums, máquina de estados pura, dinero, tipos pey
infra/
  seed/     plantilla de seed de cuentas (los IDs reales viven fuera del repo)
apps/api/migrations/   migraciones D1 generadas por drizzle-kit
```

- **Bindings**: `DB` (D1), `EVIDENCE` (R2), `ASSETS` (static assets), `RL_PUBLIC_READ`, `RL_PUBLIC_WRITE` (rate limit).
- **Secrets**: `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `SESSION_SECRET`, `DEMO_SELLER_PIN`.
- **Vars**: `PAYMENTS_MODE` (`mock|live`), `PUBLIC_APP_URL`, `PEY_BASE_URL` (default `https://api.pey.mx`).
- Un único adaptador `PeyGateway` con implementaciones `LivePeyGateway` (fetch, timeout 10 s) y `MockPeyGateway`.
- Webhook: librería `standardwebhooks` (npm) sobre el raw body.
- IDs: `crypto.randomUUID()`. Tiempos: ISO-8601 UTC en API; enteros epoch-ms en D1.
- Tests: Vitest. `packages/shared` con tests unitarios; `apps/api` con `@cloudflare/vitest-pool-workers` (D1/R2 reales en Miniflare).

---

## D. Modelo de datos (D1)

Importes en **centavos enteros**. Conversión a MXN solo en el gateway: `cents / 100` (y `Math.round(mxn * 100)` al recibir).

- **demo_bank_accounts**: `id`, `alias` («Cuenta demo 1»), `pey_bank_account_id` UNIQUE, `clabe_last4`, `codi_status`, `enabled`, `verified_at`. Nunca CLABE completa.
- **sellers**: `id`, `display_name`, `trade` (oficio, p. ej. «Herrería»), `demo_bank_account_id` FK UNIQUE, `created_at`.
- **agreements**: `id`, `code` UNIQUE (`TR-0001`), `seller_id`, `buyer_name`, `buyer_phone` (opcional; se muestra enmascarado), `title`, `description`, `acceptance_criteria`, `due_date` (opcional, `YYYY-MM-DD`), `total_cents`, `terms_json`, `terms_sha256`, `terms_version` (int, inicia 1), `status`, `shared_at`, `buyer_accepted_at`, `buyer_accepted_name`, `completed_at`, `created_at`, `updated_at`, `version` (int, se incrementa en cada cambio visible → ETag).
- **buyer_access**: `id`, `agreement_id`, `token_hash` UNIQUE, `token_ciphertext`, `issued_at`, `revoked_at`.
- **milestones**: `id`, `agreement_id`, `kind` (`ADVANCE|BALANCE`), `amount_cents`, `description`, `status`, `delivery_round` (int, default 0), `approved_at`, `paid_at`. UNIQUE(`agreement_id`,`kind`).
- **payment_requests**: `id`, `milestone_id`, `method` (`CODI_QR|CODI_PN`), `provider` (`PEY`), `provider_qr_id`, `provider_transaction_id` UNIQUE (nullable), `provider_bank_account_id`, `amount_cents`, `num_ref`, `qr_string`, `phone_last4`, `idempotency_key`, `status` (`CREATING|AWAITING_PAYMENT|PAID|EXPIRED_LOCAL|FAILED|CREATION_UNKNOWN|ABANDONED`), `failure_reason`, `last_reconciled_at`, `created_at`, `expires_at`, `paid_at`.
  - Índice único parcial: `UNIQUE(milestone_id) WHERE status IN ('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN')`.
- **evidence**: `id`, `agreement_id`, `milestone_id`, `delivery_round`, `uploaded_by` (seller id), `r2_key`, `sha256`, `mime_type`, `size_bytes`, `submitted` (bool: ya forma parte de una solicitud de revisión), `created_at`. Solo se puede borrar si `submitted = 0`.
- **reviews**: `id`, `milestone_id`, `delivery_round`, `decision` (`APPROVE|DISPUTE`), `comment`, `buyer_name`, `created_at`.
- **agreement_events** (append-only): `id`, `agreement_id`, `seq` (int, orden estable por trato; UNIQUE(`agreement_id`,`seq`)), `event_type`, `actor_type` (`SELLER|BUYER|SYSTEM|PROVIDER`), `actor_ref`, `payload_json`, `occurred_at`.
- **webhook_receipts**: `id`, `provider`, `webhook_id`, `event_type`, `transaction_id`, `payment_request_id` (nullable), `received_at`, `processed_at`, `processing_status` (`PROCESSED|DUPLICATE|UNMATCHED|PENDING_RETRY|IGNORED`), `unmatched_reason`, `payload_redacted_json` (sin `metadata.clabe`). UNIQUE(`provider`,`webhook_id`).
- **counters**: `name` PK, `value` (para `TR-xxxx` y `num_ref`).

### Event types
`AGREEMENT_CREATED`, `AGREEMENT_SHARED`, `LINK_REGENERATED`, `TERMS_ACCEPTED`, `PAYMENT_REQUEST_CREATED`, `PAYMENT_REQUEST_FAILED`, `PAYMENT_REQUEST_EXPIRED`, `PAYMENT_CONFIRMED`, `PAYMENT_UNMATCHED`, `DUPLICATE_PAYMENT_DETECTED`, `EVIDENCE_ADDED`, `EVIDENCE_REMOVED`, `REVIEW_REQUESTED`, `DELIVERY_APPROVED`, `DELIVERY_DISPUTED`, `AGREEMENT_COMPLETED`.

Visibilidad para el comprador: todos excepto `PAYMENT_UNMATCHED` y `EVIDENCE_REMOVED`; payloads sin datos bancarios.

---

## E. Máquina de estados (pura, en `packages/shared`)

**Agreement**: `DRAFT → SHARED → ACCEPTED → IN_PROGRESS → COMPLETED`; `IN_PROGRESS ⇄ DISPUTED` (re-entrega regresa a `IN_PROGRESS`).
- `IN_PROGRESS` cuando el anticipo queda `PAID`. `COMPLETED` cuando el saldo queda `PAID`.

**Anticipo**: `PENDING_ACCEPTANCE → ELIGIBLE → AWAITING_PAYMENT → PAID`; `AWAITING_PAYMENT → ELIGIBLE` si la solicitud expira/falla.

**Saldo**: `WAITING_DELIVERY → WAITING_BUYER_REVIEW → READY_TO_CHARGE → AWAITING_PAYMENT → PAID`; `WAITING_BUYER_REVIEW → DISPUTED`; `DISPUTED → WAITING_BUYER_REVIEW` (re-entrega); `AWAITING_PAYMENT → READY_TO_CHARGE` si expira/falla.

**Funciones puras** (devuelven `{ ok: true } | { ok: false, code: ErrorCode, message }`):
`canShare`, `canAccept`, `canCreatePaymentRequest(milestone, agreement)`, `canAddEvidence`, `canRequestReview`, `canReview`, `canConfirmPayment(pr, milestone)`, más `nextStatesOnPaymentConfirmed(...)`, `nextStatesOnReview(...)`, etc.

**Invariantes** (todos con test):
1. No cobrar anticipo antes de la aceptación.
2. No cobrar saldo antes de aprobación; prohibido si está `DISPUTED`.
3. El vendedor no puede aprobar su propia entrega (las rutas de revisión son solo públicas por token; la sesión de vendedor no puede usarlas: si llega cookie de vendedor dueño del trato → 403).
4. Importe y `bankAccountId` se calculan solo en servidor.
5. Pagar no altera aprobaciones; aprobar no marca `PAID`.
6. Webhook repetido no duplica pagos ni eventos.
7. Correlación: `paymentRequestId` (metadata) + `codiQrId`/`transactionId` + `bankAccountId` + importe.
8. Resultado ambiguo al crear QR/PN no dispara un nuevo cobro sin conciliar.
9. El comprador nunca ve CLABE ni teléfono completos.
10. A lo sumo una solicitud activa por hito.

---

## F. Contrato HTTP interno (`/api`)

Errores: `{ "error": { "code": ErrorCode, "message": string } }`. Códigos: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `INVALID_STATE` 409, `TERMS_MISMATCH` 409, `PAYMENT_PENDING_RECONCILIATION` 409, `RATE_LIMITED` 429, `PROVIDER_ERROR` 502, `INTERNAL` 500.

Todos los cuerpos y respuestas se definen como Zod schemas en `packages/shared/src/contracts/*` y se exportan sus tipos.

### Sistema y sesión
| Método | Ruta | Request | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ ok: true, mode: "mock"\|"live" }` |
| GET | `/api/demo/sellers` | – | `{ sellers: [{ id, displayName, trade, account: { alias, last4 } }] }` |
| POST | `/api/session` | `{ sellerId, pin }` | `{ seller: SellerSummary }` + cookie |
| GET | `/api/session` | – | `{ seller: SellerSummary }` o 401 |
| DELETE | `/api/session` | – | 204 |

### Prestador (cookie de sesión)
| Método | Ruta | Request | Response |
|---|---|---|---|
| GET | `/api/agreements` | – | `{ agreements: AgreementSummary[] }` (orden `updated_at desc`) |
| POST | `/api/agreements` | `CreateAgreementInput` | `SellerAgreementView` (DRAFT) |
| GET | `/api/agreements/:id` | – | `SellerAgreementView` |
| POST | `/api/agreements/:id/share` | `{ regenerate?: boolean }` | `{ shareUrl, whatsappUrl, agreement: SellerAgreementView }` |
| POST | `/api/agreements/:id/evidence` | multipart `file` | `EvidenceView` |
| DELETE | `/api/agreements/:id/evidence/:evidenceId` | – | 204 (solo no enviada) |
| POST | `/api/agreements/:id/request-review` | `{ note?: string }` | `SellerAgreementView` |
| GET | `/api/agreements/:id/export` | – | `text/html` imprimible |

`CreateAgreementInput`: `{ title (3–120), description (≤2000), acceptanceCriteria (3–1000), buyerName (2–80), buyerPhone? (10 dígitos), dueDate? (YYYY-MM-DD), totalCents (int ≥2, ≤ 200_000_000), advanceCents (int ≥1, < totalCents, ≤ 100_000_000) }`. `balanceCents = totalCents - advanceCents` (≥1, ≤100_000_000) calculado en servidor. `share` en el mismo paso: la UI llama `POST /agreements` y luego `/share`.

### Comprador (token público)
| Método | Ruta | Request | Response |
|---|---|---|---|
| GET | `/api/public/tratos/:token` | header `If-None-Match` | `BuyerAgreementView` + `ETag: "v<version>"` o 304 |
| POST | `/api/public/tratos/:token/accept` | `{ buyerName, termsSha256, consent: true }` | `BuyerAgreementView` |
| POST | `/api/public/tratos/:token/milestones/:milestoneId/payment-requests` | `{ method: "CODI_QR"\|"CODI_PN", phoneNumber? }` + `Idempotency-Key?` | `PaymentRequestView` (201 nueva, 200 reutilizada) |
| POST | `/api/public/tratos/:token/payment-requests/:id/refresh` | – | `PaymentRequestView` |
| POST | `/api/public/tratos/:token/review` | `{ decision: "APPROVE"\|"DISPUTE", comment?, buyerName }` (comment obligatorio 5–1000 si DISPUTE) | `BuyerAgreementView` |
| GET | `/api/public/tratos/:token/export` | – | `text/html` imprimible |

### Archivos, webhook y dev
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/files/evidence/:id?exp=&sig=` | URL firmada HMAC (TTL 15 min); `Cache-Control: private, max-age=600` |
| POST | `/api/webhooks/pey` | ver §G |
| POST | `/api/dev/simulate-payment` | `{ paymentRequestId }`; solo `PAYMENTS_MODE=mock` (si no → 404) |

### Vistas
- `SellerAgreementView`: `{ agreement: {id, code, title, description, acceptanceCriteria, buyerName, buyerPhoneMasked, dueDate, totalCents, status, termsSha256, termsVersion, sharedAt, buyerAcceptedAt, buyerAcceptedName, completedAt, createdAt, updatedAt, version}, account: {alias, last4}, milestones: MilestoneView[], paymentRequests: PaymentRequestView[], evidence: EvidenceView[], reviews: ReviewView[], events: EventView[], shareUrl: string|null, whatsappUrl: string|null, nextAction: NextAction }`.
- `BuyerAgreementView`: igual sin `shareUrl`, con `seller: { displayName, trade }`, `payee: { alias, last4 }`, eventos filtrados, `activePaymentRequest: PaymentRequestView|null`, `nextAction`.
- `MilestoneView`: `{ id, kind, amountCents, description, status, deliveryRound, approvedAt, paidAt }`.
- `PaymentRequestView`: `{ id, milestoneId, method, status, amountCents, numRef, qrString|null, phoneLast4|null, expiresAt, createdAt, paidAt }`.
- `EvidenceView`: `{ id, milestoneId, deliveryRound, url (firmada), mimeType, sizeBytes, sha256, submitted, createdAt }`.
- `EventView`: `{ id, seq, type, actorType, occurredAt, payload }`.
- `NextAction` (calculado en servidor para guiar la UI): seller: `SHARE | WAIT_ACCEPTANCE | WAIT_ADVANCE | UPLOAD_EVIDENCE | WAIT_REVIEW | RESOLVE_DISPUTE | WAIT_BALANCE | DONE`; buyer: `ACCEPT | PAY_ADVANCE | WAIT_DELIVERY | REVIEW | PAY_BALANCE | WAIT_SELLER | DONE`.

---

## G. Integración pey (verificada en OpenAPI)

Base `https://api.pey.mx`, `Authorization: Bearer ${PEY_API_KEY}`.

### Crear QR — `POST /codi/qr` → 201 `{ id, qrString, qrImage? }`
Body: `{ amount: cents/100, concept: "Trato TR-0007 anticipo" (≤ 40 chars, sin datos personales), expiration: 86400, numRef: "<7 dígitos>", generateImage: false, bankAccountId, metadata: { agreementId, milestoneId, paymentRequestId, app: "trato" } }`.

### Push — `POST /codi/pn` → 200 `{ transactionId, codiId }`
Body: `{ amount, phoneNumber (10 dígitos), concept, expiration: 600, numRef, bankAccountId, metadata }`. Mostrar «Solicitud enviada a tu teléfono», nunca «Pago confirmado».

### Alta de las 5 cuentas — `POST /bank-account` → 200 `{ id, codiStatus }`
El `bankAccountId` **no lo entrega el organizador: lo devuelve pey al registrar la CLABE**.
Body: `{ alias (1–255), name (titular, 1–255), clabe (18 dígitos, dígito verificador válido), entity: "BUSINESS"|"PERSON" }`. Errores 400: `INVALID_CLABE`, `INCOMPLETE_PARAMETERS`, `INVALID_PARAMETER`. Las cuentas nacen `PENDING` (normalmente hasta 5 días hábiles; las preautorizadas del hackatón deberían quedar `ACTIVE` rápido).

Flujo (script local en Node, **las CLABEs nunca entran al Worker, a D1 ni al repo**):
1. `infra/seed/accounts.local.json` (gitignored; plantilla versionada `accounts.example.json`): `[{ alias, name, clabe, entity, sellerDisplayName, trade }]` × 5.
2. `pnpm --filter @trato/api register-accounts`: por cada entrada **sin** `peyBankAccountId`, llama `POST /bank-account` y escribe de inmediato `peyBankAccountId` y `codiStatus` de vuelta en el archivo local. Así, si se vuelve a ejecutar, no registra dos veces la misma cuenta. Si una cuenta ya tiene ID, solo consulta `GET /bank-account/{id}`.
3. Genera `infra/seed/accounts.local.sql` (gitignored) con `demo_bank_accounts` (`pey_bank_account_id`, `clabe_last4`, `codi_status`) + `sellers`, y se aplica con `wrangler d1 execute`.
4. `pnpm --filter @trato/api verify-accounts`: consulta `GET /bank-account/{id}` y reporta estado (solo últimos 4 dígitos en consola).
5. Webhook `bank.account.updated` (`{ type, bankAccountId, codiStatus: "ACTIVE", clabe, name, entity, ownerType, ownerId, taxId? }`): el handler actualiza `demo_bank_accounts.codi_status` y `verified_at`; **descarta `clabe`/`name`/`taxId` del recibo guardado**.
6. Solo cuentas `codi_status = ACTIVE` y `enabled = 1` pueden recibir solicitudes de pago (si no → 409 `INVALID_STATE` «La cuenta del prestador aún no está activa en CoDi»). En modo mock se siembran 5 cuentas ficticias `ACTIVE`.

### Consultas
- `GET /bank-account/{id}` → `codiStatus` (`PENDING|PROCESSING|ACTIVE|ERROR`, `errorMessage` si ERROR).
- `GET /transaction/codi/qr/{qrId}` → `{ items: [{ id, status: PENDING|PAID, amount, amountBreakdown{base,tip,fee}, datePaid, metadata }], nextToken }`.
- `GET /transaction/{id}` → `{ id, status, amount, amountBreakdown, payableType, payableId, datePaid, metadata }`.

### Errores pey
400 `{ error: { message, type, requestId } }` → definitivo (`FAILED`). Timeout (10 s), error de red, 5xx, 503 → **ambiguo** (`CREATION_UNKNOWN`).

### Creación de solicitud (algoritmo)
1. Validar estado con la función pura. Si existe solicitud activa vigente para el hito → devolverla (200).
1b. Verificar que la cuenta del prestador está `ACTIVE`.
2. Si existe `CREATION_UNKNOWN`: QR → conciliar (si nunca devolvimos `qrString`, el comprador no pudo pagarla: marcar `ABANDONED` y continuar). PN → si `now < created_at + 600 s` responder 409 `PAYMENT_PENDING_RECONCILIATION`; si no, `ABANDONED` y continuar.
3. Insertar `CREATING` (el índice parcial impide carreras) + asignar `num_ref`.
4. Llamar a pey. Éxito → batch: PR `AWAITING_PAYMENT` (+ `provider_qr_id`/`provider_transaction_id`, `qr_string`, `expires_at`), hito `AWAITING_PAYMENT`, evento, `version++`. 4xx → `FAILED` + evento, hito sin cambio, 502. Ambiguo → `CREATION_UNKNOWN`, 502 con mensaje «Estamos verificando…».
5. Expiración local: al leer, si `AWAITING_PAYMENT` y `now > expires_at` → conciliar una vez; sin pago → `EXPIRED_LOCAL`, hito vuelve a elegible.

### Webhook `POST /api/webhooks/pey`
Payload plano (no hay envelope `data`):
- `codi.qr.payment_received`: `{ type, amount, apiKeyId, bankAccountId, codiQrId, concept, datePaid, numRef, transactionId, metadata: { clabe, bankCode, accountType, description, trackingKey, externalMetadata: {...strings} } }`
- `codi.pn.payment_received`: igual sin `codiQrId` (`bankAccountId` presente si se envió al crear).

Pipeline:
1. `raw = await c.req.text()`; verificar con `new Webhook(PEY_WEBHOOK_SECRET).verify(raw, headers)`; fallo → 401.
2. `INSERT webhook_receipts ... ON CONFLICT(provider, webhook_id) DO NOTHING`; si no insertó: si el recibo existente está en `PENDING_RETRY` → reprocesar (pasos 3–7); en otro caso → 200 `{ duplicate: true }`.
3. Parsear con Zod (`PeyWebhookEventSchema`); `bank.account.updated` → actualizar cuenta, `PROCESSED`, 200 (sin pasos 4–6); tipo desconocido → `IGNORED`, 200.
4. Correlacionar: `externalMetadata.paymentRequestId` → PR; si no hay, por `provider_qr_id = codiQrId` o `provider_transaction_id = transactionId`. Si no se encuentra → `PENDING_RETRY` (posible carrera) y responder **503** para que pey reintente; el handler de reconciliación también reprocesa `PENDING_RETRY` al consultar la PR.
5. Validar `bankAccountId == pr.provider_bank_account_id`, importe (regla §A.2), `codiQrId == pr.provider_qr_id` (QR) o `transactionId == pr.provider_transaction_id` (PN, si se conoce). Fallo → `UNMATCHED` + evento `PAYMENT_UNMATCHED` (solo vendedor), 200, **nunca PAID**.
6. Transición idempotente en un `batch`: `UPDATE payment_requests SET status='PAID', provider_transaction_id=?, paid_at=? WHERE id=? AND status IN ('AWAITING_PAYMENT','EXPIRED_LOCAL','CREATION_UNKNOWN')`; `UPDATE milestones SET status='PAID' ... WHERE id=? AND status <> 'PAID'`; evento `PAYMENT_CONFIRMED`; actualizar agreement (`IN_PROGRESS` o `COMPLETED` + `AGREEMENT_COMPLETED`), `version++`. Si el hito ya estaba `PAID` por otra PR → `DUPLICATE_PAYMENT_DETECTED`.
7. Marcar recibo `PROCESSED`; responder 200. Excepción inesperada → 500 (pey reintenta) y el recibo queda `PENDING_RETRY` (el reintento lo reprocesa porque se permite reprocesar recibos en `PENDING_RETRY`).

La conciliación por consulta (`refresh`) usa exactamente la misma función `confirmPayment(prId, providerTx)` que el webhook.

---

## H. Pantallas (móvil primero, ≤ 5)

1. **Entrar / Inicio prestador** (`/`): elegir perfil demo + PIN; luego lista de tratos con chip de estado y «siguiente acción»; botón «Nuevo trato».
2. **Nuevo trato** (`/tratos/nuevo`): título, descripción, criterios de entrega, nombre y teléfono (opcional) del comprador, fecha, total y anticipo (slider/presets 30/50 %, saldo calculado en vivo, formato MXN). Botón «Crear y compartir por WhatsApp».
3. **Trato (prestador)** (`/tratos/:id`): stepper de progreso, copiar/compartir enlace, subir 1–3 fotos con previsualización (compresión cliente), «Solicitar revisión», disputas visibles con motivo, botón «Exportar».
4. **Trato (comprador)** (`/t/:token`): condiciones + quién cobra (alias •••• 1234) + hash corto; aceptar; QR grande (se genera en cliente con `qrcode`) con monto, referencia, cuenta regresiva y «Ya pagué, verificar»; alternativa push con teléfono; revisar fotos (lightbox) y «Recibido, todo bien» / «Reportar problema»; luego «Pagar saldo».
5. **Historial / Export** (sección en 3 y 4 + `/api/.../export`): línea de tiempo, export HTML imprimible con términos, hash, fotos (data-URI o URL firmada), pagos y eventos.

Microcopy obligatorio: «Acuerdo aceptado» ≠ «Anticipo recibido»; «Solicitud enviada» ≠ «Pago confirmado»; «Trabajo recibido» ≠ «Saldo pagado».

Rendimiento web: code-splitting por ruta (seller vs buyer), la ruta `/t/:token` no carga el bundle del prestador; `qrcode` y el compresor de imágenes con `import()` dinámico; sin librerías de estado global (fetch + hooks propios); objetivo < 120 KB gzip para la vista del comprador.

---

## I. Seguridad
- Secrets solo con `wrangler secret`; nada en `VITE_*`.
- Token comprador: 32 bytes aleatorios base64url; DB guarda `sha256` + ciphertext.
- Cookies: HMAC-SHA256 con `SESSION_SECRET`; comparación en tiempo constante.
- Logs: nunca CLABE, teléfono completo, token, ni headers `Authorization`/`webhook-signature`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` en `/t/*` (el token está en la URL), CSP básica.
- Export y vistas: aviso de que no sustituye pericial, firma robusta ni resolución judicial.

## J. Definition of done
Igual que v0.1 §9, más:
- [ ] `refresh` marca PAID con la misma lógica que el webhook (test).
- [ ] Doble clic en «Pagar» crea una sola solicitud (test de concurrencia con índice parcial).
- [ ] Webhook con `amount` = base + fee concilia si `base` coincide (test con mock de `/transaction/{id}`).
- [ ] Webhook antes de que exista la PR → 503 y luego se concilia en reintento (test).
- [ ] Re-entrega tras disputa conserva evidencia y revisión previas (test).
- [ ] `simulate-payment` devuelve 404 en modo live (test).

## K. Orden de implementación
1. `packages/shared`: contratos Zod, enums, dinero, máquina de estados + tests.
2. `apps/api` (a): esquema Drizzle + migraciones, seed demo, sesión, acuerdos, share, vista pública, accept.
3. `apps/api` (b): `PeyGateway` (mock/live), payment requests, webhook, refresh, simulate.
4. `apps/api` (c): evidencias R2, request-review, review, re-entrega, export.
5. `apps/web`: shell + login + lista + nuevo trato → vista comprador → evidencias/revisión → historial/export.
6. Despliegue y verificación de cuentas reales (`verify-accounts`).
