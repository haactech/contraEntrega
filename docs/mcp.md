# Trato por MCP: conecta un agente

Trato expone un servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) para que el agente de IA del **prestador** y el del **comprador** operen un trato con las mismas reglas que la app web: mismos servicios, mismos contratos, mismos eventos de auditoría.

- **URL**: `https://<tu-dominio>/mcp` (local: `http://localhost:8787/mcp`).
- **Transporte**: Streamable HTTP, **sin estado** (cada `POST` es independiente, no hay sesiones ni SSE). Solo acepta `POST` con `Content-Type: application/json`; el cuerpo máximo es 8 MB (por la evidencia en base64).
- **Protocolo**: JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`).
- Cada herramienta devuelve `structuredContent` (validado contra su esquema de salida) y, como texto, el mismo JSON. **Toda salida incluye `allowedActions`**: las acciones que se pueden ejecutar ahora. No intentes otras.

## Cómo obtener la llave del prestador

1. Inicia sesión en Trato como prestador y abre **Ajustes > Conectar un agente** (`/ajustes/agentes`).
2. Crea una llave con un nombre (por ejemplo «Claude Desktop»). El secreto (`trk_...`) se muestra **una sola vez**; guárdalo en un gestor de secretos. Trato solo conserva su hash SHA-256.
3. Máximo 5 llaves activas por prestador. Puedes revocarlas en cualquier momento; una llave revocada se rechaza de inmediato.

(API equivalente, con sesión de prestador: `POST /api/api-keys`, `GET /api/api-keys`, `DELETE /api/api-keys/:id`.)

Los **compradores no necesitan llave**: sus herramientas reciben el `buyerToken`, la parte final del enlace que les envió el prestador (`/t/<buyerToken>`).

## Configuración en un cliente MCP genérico

Cualquier cliente con transporte HTTP (Streamable HTTP) necesita la URL y, para el prestador, el encabezado `Authorization`:

```json
{
  "mcpServers": {
    "trato": {
      "type": "http",
      "url": "https://<tu-dominio>/mcp",
      "headers": { "Authorization": "Bearer trk_TU_LLAVE" }
    }
  }
}
```

Para el agente del comprador, omite el encabezado (o usa otra configuración sin llave). Prueba rápida con `curl`:

```bash
curl -s https://<tu-dominio>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer trk_TU_LLAVE' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Autenticación y errores

| Situación | Resultado |
| --- | --- |
| Herramienta de prestador sin llave | Resultado con `isError: true` y código `UNAUTHORIZED` |
| Llave inválida o revocada (aunque la herramienta sea de comprador) | HTTP 401 |
| `buyerToken` inexistente o enlace revocado | `isError`, `NOT_FOUND` |
| Llave del **dueño** del trato + `buyerToken` de ese trato | `isError`, `FORBIDDEN` (el prestador no acepta, paga ni aprueba su propio trato) |
| Datos inválidos | `isError`, `VALIDATION_ERROR` |
| Acción no permitida en el estado actual | `isError`, `INVALID_STATE` |
| Demasiadas solicitudes | `isError`, `RATE_LIMITED` |
| Herramienta inexistente, JSON mal formado | Error JSON-RPC |

Los errores de dominio llegan como texto JSON `{"error":{"code":"...","message":"..."}}` con el mensaje en español. Límites: las herramientas que escriben comparten el límite de escritura pública y las de lectura el de lectura, por llave (o por `buyerToken`) e IP.

## Herramientas

### Prestador (requieren `Authorization: Bearer trk_...`)

| Herramienta | Qué hace | Precondiciones |
| --- | --- | --- |
| `list_agreements` | Lista tus tratos (más reciente primero) con `allowedActions` por trato. Filtro `status`, `limit`. | — |
| `get_agreement` | Detalle completo: hitos, pagos, evidencias, revisiones, eventos. | El trato es tuyo (si no, `NOT_FOUND`). |
| `create_agreement` | Crea un trato en borrador con términos estructurados (pesos MXN). | Ya acordaste los términos con el comprador; anticipo menor al total. |
| `share_agreement` | Genera el enlace del comprador (`shareUrl`, `whatsappUrl`); `regenerate` invalida el anterior. | El trato no está completado. |
| `add_evidence` | Adjunta una foto de la entrega (base64, JPEG/PNG/WebP, ≤ 5 MB, máx. 3 por entrega). Se valida el contenido real del archivo, no el tipo declarado. | Anticipo pagado y `UPLOAD_EVIDENCE` permitido. |
| `request_review` | Envía la entrega a revisión del comprador (o re-entrega tras una disputa). | Al menos una foto sin enviar (`REQUEST_REVIEW` o `REDELIVER`). |
| `export_agreement` | Comprobante imprimible en HTML. | — |

### Comprador (sin llave; reciben `buyerToken`)

| Herramienta | Qué hace | Precondiciones |
| --- | --- | --- |
| `buyer_get_agreement` | Trato visible para el comprador (términos, hitos, pagos, evidencias enviadas). | Token válido. |
| `buyer_accept` | Acepta los términos. Exige `termsSha256` vigente y `consent: true`; si cambiaron, `TERMS_MISMATCH`. | `ACCEPT_TERMS` permitido. La persona lo pidió. |
| `buyer_review` | `APPROVE` (recibido y conforme) o `DISPUTE` (con comentario). | `APPROVE_DELIVERY` permitido. Decisión de la persona. |
| `buyer_create_payment_request` | Crea la solicitud CoDi del anticipo o saldo, por QR o push (`CODI_PN`, con teléfono). El importe y la cuenta salen de la base de datos. | `PAY_ADVANCE` o `PAY_BALANCE` permitido. |
| `buyer_refresh_payment` | Consulta al proveedor el estado de una solicitud pendiente y la concilia. | Solicitud existente del trato. |

## Recorrido: liberar dinero con evidencias

1. **Prestador**: `create_agreement` → `share_agreement` (entrega el enlace al comprador).
2. **Comprador**: `buyer_get_agreement` → `buyer_accept` (con el `termsSha256` que leyó) → `buyer_create_payment_request` (`ADVANCE`) → la persona autoriza el anticipo en su app bancaria → `buyer_refresh_payment` hasta ver `PAID`.
3. **Prestador**: termina el trabajo y llama `add_evidence` (1 a 3 fotos) → `request_review`.
4. **Agente del comprador**: `buyer_get_agreement` y **revisa las evidencias** (`evidence`, con enlaces firmados temporales). Si la persona está conforme: `buyer_review` con `APPROVE` (si no, `DISPUTE` con comentario; el prestador puede re-entregar con `REDELIVER`).
5. **Comprador**: `buyer_create_payment_request` (`BALANCE`, por ejemplo `CODI_PN` con su teléfono) → la persona autoriza el pago en su banco → `buyer_refresh_payment`.
6. Cuando el proveedor confirma el pago, el trato pasa a `COMPLETED`; el prestador puede llamar `export_agreement` para el comprobante.

En cada paso, consulta `allowedActions` de la respuesta anterior.

## Qué NO puede hacer ningún agente

- **Marcar un pago como pagado.** Solo el evento verificado del proveedor de pagos (webhook firmado o conciliación) confirma un pago. Crear una solicitud no cobra: la persona debe autorizarla en su banco.
- **Cambiar montos, anticipo o la cuenta de cobro.** Los importes se fijan al crear el trato y se leen de la base de datos; cualquier campo monetario que envíe un agente se ignora. Una vez aceptados, los términos son inmutables.
- **Aprobar su propia entrega.** La llave del prestador dueño no puede usar las herramientas de comprador sobre su trato (`FORBIDDEN`).
- **Ver datos sensibles.** Las respuestas nunca incluyen la CLABE (solo alias y últimos 4 dígitos), el teléfono completo, identificadores internos del proveedor de pagos ni la llave de API. El comprador no ve evidencias en borrador ni eventos internos.
- **Descargar imágenes desde URLs remotas.** `add_evidence` solo acepta la imagen en base64.

Cada acción hecha por MCP queda en el historial del trato con `via: "mcp"` y, para el prestador, el actor `mcp:<id de la llave>`.
