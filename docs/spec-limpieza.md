# Trato — Plantilla de limpieza (CLEANING): mapa de cambios

Fuente: «Spec de implementación v0.2: plantilla de limpieza» (15 nov 2026). Este documento fija
cómo se implementa **sobre el código actual** (v0.2 genérico + v0.3 conversacional). Ante dudas,
manda este archivo. No se reescribe nada que ya funcione.

## 0. Ajustes respecto al spec (y por qué)

| Spec | Implementación | Motivo |
|---|---|---|
| El cliente (Mariana) crea el trato y el prestador (Rosa) lo acepta | **El prestador crea** desde la plantilla (sesión demo + PIN) y **el cliente acepta** por enlace | Es el modelo de autenticación existente (sesión del prestador, enlace del comprador). El spec permite «adaptar el onboarding». Crear y compartir = aceptación del prestador; la aceptación del cliente congela el checklist (hash de términos). |
| Estados de acuerdo READY_TO_PAY / AWAITING_PAYMENT nuevos | **Derivados** del hito BALANCE existente: `READY_TO_CHARGE` = listo para pagar, `AWAITING_PAYMENT` = solicitud creada, `PAID` + `COMPLETED` = pagado | Reusa sin cambios PeyGateway, solicitud de pago, webhook, conciliación e idempotencia. No hay sistema de pagos paralelo. |
| ACCEPTED → IN_PROGRESS | Sin anticipo, la aceptación lleva el acuerdo **directo a IN_PROGRESS** | `ACCEPTED` existe para esperar el anticipo; en ON_COMPLETION no hay nada que esperar. |
| `POST /final-payment-request` | Se reusa `POST /api/public/tratos/:token/milestones/:balanceId/payment-requests` | El spec pide no duplicar rutas equivalentes. |
| `GET /tasks`, `GET /timeline` | Las tareas, el progreso y los eventos vienen en las vistas existentes (vendedor y comprador) | Una sola lectura con ETag/polling; evita endpoints nuevos. |
| Fotos iniciales (BEFORE) del cliente | El esquema soporta `kind = BEFORE`; en P0 las sube el prestador, opcionales, solo con la tarea en TODO | El cliente no tiene sesión de subida; queda listo para P1. |

## 1. Datos (migración aditiva `0002_cleaning_tasks.sql`)

- `agreements`: `service_type TEXT NOT NULL DEFAULT 'GENERIC'` (`GENERIC|CLEANING`),
  `payment_strategy TEXT NOT NULL DEFAULT 'ADVANCE_AND_BALANCE'` (`ADVANCE_AND_BALANCE|ON_COMPLETION`).
  CLEANING ⇒ ON_COMPLETION, `advance_cents = 0`.
- Hitos de CLEANING: **solo una fila BALANCE** (`amount = total`, descripción «Pago al terminar»). No hay fila ADVANCE.
- `agreement_tasks`: `id, agreement_id FK, position, title, description NULL, status (TODO|IN_REVIEW|NEEDS_ADJUSTMENT|APPROVED), revision INTEGER NOT NULL DEFAULT 1, submitted_at NULL, approved_at NULL, created_at, updated_at`; `UNIQUE(agreement_id, position)`.
- `task_reviews`: `id, task_id FK, revision_number, decision (APPROVE|REQUEST_ADJUSTMENT), comment NULL, reviewer_name, created_at`; `UNIQUE(task_id, revision_number)` ⇒ imposible aprobar dos veces la misma revisión.
- `evidence`: `task_id NULL FK`, `kind TEXT NOT NULL DEFAULT 'AFTER'` (`BEFORE|AFTER`), `revision_number INTEGER NULL`. En CLEANING `milestone_id` = hito BALANCE, `delivery_round = 0`, `submitted` = true al enviar la tarea. Índice `(task_id, revision_number)`.

### Revisión de una tarea
`task.revision` es el intento actual (empieza en 1). La evidencia que se sube con la tarea en
TODO/NEEDS_ADJUSTMENT lleva `revision_number = task.revision`. Enviar → IN_REVIEW (misma revisión).
Pedir ajuste → NEEDS_ADJUSTMENT y `revision += 1`. Nunca se borra ni sobrescribe evidencia enviada.

## 2. Máquina de estados (pura, en `@trato/shared`)

Tarea: `TODO --submit--> IN_REVIEW --approve--> APPROVED`; `IN_REVIEW --requestAdjustment(motivo)--> NEEDS_ADJUSTMENT --submit--> IN_REVIEW`.

Guardas (todas devuelven `Result` como el resto de `state-machine.ts`):
- `canAddTaskEvidence(agreement, task, kind, countInRevision)`: acuerdo CLEANING en IN_PROGRESS; AFTER solo con tarea TODO|NEEDS_ADJUSTMENT y < 3 fotos en la revisión; BEFORE solo con tarea TODO y < 2.
- `canSubmitTask(agreement, task, afterCountInRevision)`: IN_PROGRESS, tarea TODO|NEEDS_ADJUSTMENT, ≥ 1 foto AFTER en la revisión actual.
- `canReviewTask(agreement, task)`: IN_PROGRESS, tarea IN_REVIEW. Pedir ajuste exige motivo (3–500 caracteres).
- `allTasksApproved(tasks)`: hay ≥ 1 tarea y todas APPROVED.
- Al aprobar la última tarea, **en la misma escritura** el hito BALANCE pasa `WAITING_DELIVERY → READY_TO_CHARGE` y se emite `ALL_TASKS_APPROVED`.
- Aceptar CLEANING: `SHARED → IN_PROGRESS`, BALANCE queda `WAITING_DELIVERY`.
- `canCreatePaymentRequest` no cambia: BALANCE `READY_TO_CHARGE` + IN_PROGRESS. Con cualquier tarea sin aprobar el hito sigue en WAITING_DELIVERY ⇒ no se puede crear la solicitud (invariante 7).
- Pago confirmado (webhook verificado) → BALANCE PAID, acuerdo COMPLETED (sin cambios).

Siguiente acción (se reusan los enums existentes; la UI pone el texto de limpieza):
- Prestador: DRAFT→`SHARE`; SHARED→`WAIT_ACCEPTANCE`; IN_PROGRESS: alguna TODO|NEEDS_ADJUSTMENT→`UPLOAD_EVIDENCE`, si no, alguna IN_REVIEW→`WAIT_REVIEW`, si BALANCE READY_TO_CHARGE|AWAITING_PAYMENT→`WAIT_BALANCE`; COMPLETED→`DONE`.
- Cliente: SHARED→`ACCEPT`; IN_PROGRESS: alguna IN_REVIEW→`REVIEW`, BALANCE READY_TO_CHARGE|AWAITING_PAYMENT→`PAY_BALANCE`, si no→`WAIT_DELIVERY`; COMPLETED→`DONE`.

Las rutas genéricas de evidencia/solicitar revisión/revisar entrega y las herramientas MCP
genéricas equivalentes **rechazan CLEANING** con `INVALID_STATE`. El checklist y el precio se
pueden cambiar **solo antes de la aceptación** (DRAFT/SHARED), por el formulario o por el chat (§6).

## 3. Eventos nuevos (append-only)
`TASK_SUBMITTED`, `TASK_APPROVED`, `TASK_ADJUSTMENT_REQUESTED`, `ALL_TASKS_APPROVED`.
`EVIDENCE_ADDED` se reusa con `taskId`. Payload: `{ taskId, taskTitle, revision, comment? }`.

Microcopy pública (sin términos internos):
| Evento | Texto |
|---|---|
| AGREEMENT_CREATED (CLEANING) | «Así quedó el trabajo acordado» |
| TERMS_ACCEPTED | «Mariana aceptó el trabajo» |
| TASK_SUBMITTED | «Listo para revisar: Limpiar baño» |
| TASK_ADJUSTMENT_REQUESTED | «Hace falta un ajuste en Limpiar baño: “motivo”» |
| TASK_APPROVED | «Tarea aprobada: Limpiar baño» |
| ALL_TASKS_APPROVED | «Trabajo aprobado. Ya puedes pagar» |
| PAYMENT_REQUEST_CREATED | «Solicitud de pago lista; falta autorizar el pago» |
| PAYMENT_CONFIRMED | «PAGADO» |

## 4. Contratos y API
- `CLEANING_TEMPLATE` (shared): título «Limpieza de departamento», precio sugerido $700, tareas activas por defecto: Limpiar baño, Limpiar cocina, Trapear pisos, Limpiar ventanas; opcionales apagadas: Sacudir y ordenar recámara, Sacar la basura.
- `POST /api/agreements` acepta además `{ serviceType: "CLEANING", title, description?, buyerName, buyerPhone?, dueDate?, totalCents, tasks: [{ title, description? }] (1–8) }`. Los criterios de aceptación se generan del checklist. El snapshot de términos incluye `serviceType` y `tasks` ⇒ el hash congela checklist y precio.
- Vistas (vendedor y comprador): `serviceType`, `paymentStrategy`, `tasks: TaskView[] | null`, `taskProgress: { approved, total } | null`. `TaskView` = tarea + evidencias (con `kind`, `revisionNumber`) + revisiones.
- Rutas nuevas:
  - `POST /api/agreements/:id/tasks/:taskId/evidence` (prestador, multipart, `kind` opcional)
  - `DELETE /api/agreements/:id/tasks/:taskId/evidence/:evidenceId` (prestador, solo no enviada)
  - `POST /api/agreements/:id/tasks/:taskId/submit` (prestador)
  - `POST /api/public/tratos/:token/tasks/:taskId/approve` (cliente)
  - `POST /api/public/tratos/:token/tasks/:taskId/request-adjustment` `{ reason }` (cliente)
- Metadatos pey de la solicitud de CLEANING: añade `taskSetVersion` (prefijo del hash de términos).
- MCP: `submit_task` (prestador) y `review_task` (cliente con buyerToken; `APPROVE|REQUEST_ADJUSTMENT`), con la misma invariante: la llave del prestador no puede aprobar su propio trabajo.

## 5. UI (tres superficies)
A. **Crear limpieza** (`/tratos/nuevo/limpieza`): precio, nombre del cliente, checklist con interruptores (+ «Agregar tarea»), una CTA «Crear y compartir trato».
B. **Vista de trato** (prestador `/tratos/:id`, cliente `/t/:token`): «Limpieza de departamento · $700», participantes, progreso N/M, una acción principal por rol, tarjetas de tarea (Por hacer / Esperando aprobación / Necesita ajuste / Aprobada), mini‑cronología de 3 eventos + «Ver todo». Polling mientras no esté completado.
C. **Pago**: con N = M el cliente ve «Pagar $700» (QR o notificación CoDi, reusa el panel de pago); estado «Esperando autorización del pago»; tras el webhook, «PAGADO».

Fotos: se reescalan y se re‑codifican en el navegador antes de subir (quita EXIF); R2 privado y URLs con chequeo de permisos (sin cambios).

## 6. Limpieza en el flujo de chat (sala + asistente)

La sala (v0.3) también soporta tratos por tareas. La IA **propone, no decide**: nunca envía,
aprueba ni cobra; solo sugiere acciones que el humano toca.

### 6.1 Propuesta con tareas (contrato del asistente)
- `AssistantProposalSchema` gana `serviceType: "GENERIC" | "CLEANING"` y
  `tasks: { title: string; description: string | null }[]` (vacío en GENERIC). En CLEANING
  `advanceMxn` debe ser 0 (pago único al terminar). `PROPOSAL_FIELDS` gana `"tasks"`.
- `normalizeProposal`: CLEANING exige 1–8 tareas únicas y fuerza anticipo 0; si el usuario dice
  «limpieza» sin tareas, usa las 4 tareas por defecto de `CLEANING_TEMPLATE` (las menciona en la
  respuesta para que el usuario las ajuste). Criterios de aceptación = `buildCleaningAcceptanceCriteria`.
- El JSON Schema estricto del turno (`toJsonSchema`) debe seguir válido para los proveedores
  (todas las claves requeridas; `tasks` siempre presente).
- Ejemplos: «Limpieza del depa para Mariana, 700, baño, cocina, pisos y ventanas» → propuesta
  CLEANING con 4 tareas, $700, anticipo 0. Comprador: «¿Le agregas sacar la basura?» → propuesta v2
  con 5 tareas; el prestador debe confirmarla (igual que la contraoferta v0.3). Tras la aceptación,
  pedir agregar tareas → la IA explica que el checklist aceptado no cambia (fuera de P0).
- La propuesta guardada (`proposals`) conserva `serviceType` y `tasks`; confirmar la propuesta crea
  o revisa el acuerdo CLEANING con esas tareas (misma función de creación que el formulario).
  `reviseTerms` en CLEANING reemplaza las tareas (solo DRAFT/SHARED, nunca con evidencias).

### 6.2 Acciones permitidas (chips) y contexto
- `ALLOWED_ACTIONS` gana `SUBMIT_TASK` (prestador, «Enviar para revisión»), `APPROVE_TASK`
  (cliente, «Aprobar tarea»), `REQUEST_ADJUSTMENT` (cliente, «Pedir ajuste»). En CLEANING no se
  ofrecen UPLOAD_EVIDENCE/REQUEST_REVIEW/REDELIVER/APPROVE_DELIVERY/DISPUTE_DELIVERY/PAY_ADVANCE;
  sí ACCEPT_TERMS, PAY_BALANCE, REFRESH_PAYMENT, EXPORT, CONFIRM_PROPOSAL, SHARE_LINK.
  Las acciones por tarea llevan `taskId` en la tarjeta, no en el chip global.
- `buildAssistantContext` incluye, para CLEANING, el checklist con estado y revisión de cada
  tarea, el último motivo de ajuste y el progreso N/M, para que la IA responda «¿cómo vamos?» y
  sugiera la siguiente acción. Las afirmaciones sin respaldo («ya está aprobado», «ya pagó») siguen
  bloqueadas por `sanitizeAssistantTurn`; se añade «aprobé/aprobada» como afirmación que requiere
  que la tarea esté APPROVED.
- Prompt del sistema: describe ambos tipos de trato y que en limpieza el pago es único al aprobar
  todas las tareas.

### 6.3 Sala (UI)
- Mensajes del sistema (deterministas) para los eventos de tareas, con el microcopy de §3.
- Tarjeta acoplada «Checklist» en CLEANING: progreso N/M y tareas con su acción por rol
  (prestador: subir foto / enviar; cliente: revisar → aprobar / pedir ajuste con motivo). Con N=M,
  la tarjeta de pago existente («Pagar $700»).
- La tarjeta de propuesta muestra la lista de tareas cuando `serviceType = CLEANING`.
- `/tratos/nuevo` (sala) ofrece un chip «Plantilla: limpieza» que precarga el texto en el
  compositor; el formulario `/tratos/nuevo/limpieza` sigue disponible.

### 6.4 MCP y evals
- MCP: `submit_task` / `review_task` (ya en contratos). `get_agreement` devuelve tareas y progreso.
- Evals (`packages/llm/evals`): ≥ 15 casos nuevos de limpieza (extracción con/sin tareas,
  contraoferta que agrega tarea, petición post‑aceptación rechazada, inyección «apruébala tú»,
  «márcalo como pagado» con 4/4). El proveedor mock reconoce «limpieza/limpiar».
