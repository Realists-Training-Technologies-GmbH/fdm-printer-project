# PrusaHero — Auditoría UX (2026-06-03)

Auditoría completa del frontend (`client/`) motivada por feedback de campo:
operadores reportan que **al enviar a imprimir no hay feedback** y que el botón
**"enviar siguiente" sigue activo mientras la impresora ya imprime**.

Severidades: **P0** = roto / confuso / riesgoso · **P1** = fricción notable · **P2** = pulido.

> Confianza: los hallazgos marcados ✅ están verificados leyendo el código.
> El resto provienen del barrido automatizado y **deben validarse** antes de implementar
> (algunos pueden ser inexactos).

---

## Tema transversal #1 — Feedback de acciones (la queja principal)

La causa raíz de "no da feedback" es doble: **acciones sin toast de éxito** +
**infraestructura de snackbar frágil**.

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| F1 | P0 ✅ | `processNextInQueue()` (enviar a imprimir) solo muestra snackbar en error; en éxito recarga la cola en silencio. | `PrinterDetail/PrinterDetailView.vue:2084` |
| F2 | P0 | Snackbar es **single-message**: un segundo toast sobreescribe al primero antes de mostrarse → notificaciones perdidas. Falta cola FIFO. | `Generic/Snackbars/AppInfoSnackbar.vue:50`, `AppErrorSnackbar.vue:50` |
| F3 | P0 | Timeouts incoherentes: info **2000ms** (muy corto), error 10000ms, sin variante "success"/"warning". | `AppInfoSnackbar.vue:53`, `AppErrorSnackbar.vue:50` |
| F4 | P0 | Errores HTTP no-401/403 se mandan a `captureException` (Sentry = no-op) y **nunca llegan al usuario** como toast. | `shared/http-client.ts:89`, `utils/sentry.util.ts:8` |
| F5 | P0 | Snackbars sin `role="alert"`/`aria-live` → invisibles para lectores de pantalla. | `Generic/Snackbars/*.vue` |
| F6 | P1 | Sin distinción visual success vs info vs warning (todo cae en el canal "info"). | `shared/snackbar.composable.ts:13` |

---

## Tema transversal #2 — Estados deshabilitados sin explicar

Botones que se deshabilitan sin tooltip que diga **por qué** (offline, ya en curso, imprimiendo…).

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| D1 | P0 ✅ | **"Send to print" sigue habilitado mientras imprime**: la condición `:disabled` no incluye `isPrinting`/`isPaused`. Con dispatch manual (operador limpia la cama), esto permite mandar un segundo print sobre uno en curso. | `PrinterDetailView.vue:515` (flags en `:2301`) |
| D2 | P1 | "Send to print" deshabilitado sin tooltip ("Offline" / "No operativa" / "Imprimiendo"). | `PrinterDetailView.vue:510` |
| D3 | P1 | Botones "Add to queue" (storage y USB) deshabilitados sin tooltip. | `PrinterDetailView.vue:904`, `1158` |
| D4 | P1 | Toggle enable/disable de impresora (lista) sin loading ni rollback en fallo; muta UI optimista y queda inconsistente si el server falla. | `PrinterList/PrintersView.vue:89` |
| D5 | P1 | Botones de control en grid tiles (pause/stop) deshabilitados sin explicación. | `PrinterGrid/PrinterGridTile.vue:277` |

---

## Tema transversal #3 — Acciones destructivas sin (o con débil) confirmación

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| X1 | P0 | **Quitar job de la cola** borra al primer clic, sin confirmación (la "X" se lee como "cerrar"). En dispatch manual la cola es valiosa. | `PrinterDetailView.vue:428`, `601`, `2104` |
| X2 | P0 | Bulk delete en Files no desglosa "N archivos + M carpetas (con su contenido anidado)". | `Files/FilesView.vue:1221` |
| X3 | P0 | Botón **Discard** de Intake es un icono diminuto, fácil de pulsar por error (sí hay confirmación, pero la afordancia invita al accidente). | `Intake/IntakeView.vue:87` |
| X4 | P0 | Regenerar API key de slicer **sin confirmación** → rompe uploads del slicer en uso. | `Settings/SlicerSettings.vue:82` |
| X5 | P0 | Desactivar login usa `window.confirm()` nativo para un cambio de seguridad crítico. | `Settings/ServerProtectionSettings.vue:143` |
| X6 | P1 | "Clear queue" no se ve destructivo (icono pequeño, sin color de advertencia) — aunque sí confirma. | `PrinterDetailView.vue:369` |

---

## Cola / Dispatch / Intake — consistencia del flujo

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| Q1 | P0 | `QueueFileDialog` no sugiere impresora; Intake sí marca "Suggested". Mismo concepto, UX divergente. | `Files/QueueFileDialog.vue`, `Intake/IntakeView.vue:209` |
| Q2 | P0 | Razón de incompatibilidad opaca: fallback "incompatible format" no distingue formato vs deshabilitada vs mantenimiento. | `QueueFileDialog.vue:108`, `IntakeView.vue:240` |
| Q3 | P1 | Botones de submit (dispatch/queue) sin estado `:loading` durante la petición. | `QueueFileDialog.vue:124`, `IntakeView.vue:269` |
| Q4 | P1 | Intake calcula impresora sugerida pero **no la pre-selecciona**. | `IntakeView.vue:483` |
| Q5 | P1 | Afordancia de drag-and-drop de la cola solo aparece con >1 item. | `PrinterDetailView.vue:348`, `420` |
| Q6 | P1 | ~15 refs de loading sueltos (`queueProcessingNext`, `addingStorageId`, …) sin sincronía cuando una acción refresca varias listas. | `PrinterDetailView.vue` (varios) |
| Q7 | P1 | Lista de incompatibles colapsada incluso cuando **no hay** compatibles (hay que expandir para entender por qué). | `QueueFileDialog.vue:95`, `IntakeView.vue:230` |

---

## Forms / Onboarding / Settings

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| S1 | P0 | Add Printer: validación solo al enviar; sin feedback inline (URL/usuario/clave). | `Generic/Dialogs/AddOrUpdatePrinterDialog.vue:82` |
| S2 | P0 | FirstTimeSetup: reglas de password solo corren en submit; sin feedback al teclear ni match en vivo. | `FirstTimeSetup/FirstTimeSetupView.vue:241` |
| S3 | P0 | Crear API key sin toast de éxito; si se cierra el modal, el token (one-time) se pierde sin recuperación. | `Settings/ApiKeysSettings.vue:288` |
| S4 | P0 | Estado de mantenimiento poco claro: no se explica el ciclo (log → deshabilitada → completar). | `Generic/Dialogs/PrinterMaintenanceDialog.vue:145` |
| S5 | P1 | "Test connection" muestra resultados en panel poco descubrible; el usuario puede no notar que corrió. | `AddOrUpdatePrinterDialog.vue:75` |
| S6 | P1 | Quick-items de mantenimiento sobreescriben el campo "cause" si el usuario ya escribió. | `PrinterMaintenanceDialog.vue:245` |
| S7 | P1 | AccountSettings: cambio de password sin validación inline (match/fuerza). | `Settings/AccountSettings.vue:29` |

---

## Grid / Dashboard / Realtime

| # | Sev | Hallazgo | Archivo |
|---|-----|----------|---------|
| G1 | P0 ⚠ | Dashboard: tiles de impresora navegarían siempre a `/printer-grid` en vez del detalle de esa impresora. **(Validar — posible falso positivo)** | `Dashboard/DashboardView.vue:133`, `537` |
| G2 | P0 | Carga de historial de jobs falla en silencio (`recentJobs=[]`), sin distinguir "sin datos" de "error". | `Dashboard/DashboardView.vue:446` |
| G3 | P0 | Imágenes de cámara sin timeout ni fallback: spinner infinito si el stream cuelga. | `CameraGrid/CameraGridView.vue:454` |
| G4 | P1 | No hay indicador de "datos posiblemente obsoletos" en desconexión breve de socket; el overlay full-screen bloquea todo. | `AppLoader.vue:234`, `shared/socketio.service.ts:238` |
| G5 | P1 | KPI "Offline / Issue" mezcla desconectadas + en mantenimiento en un solo número. | `Dashboard/DashboardView.vue:83` |
| G6 | P2 | Sin badge "perdió conexión" en el tile cuando una impresora cae a mitad de print. | `PrinterGrid/PrinterGridTile.vue` |
| G7 | P1 | Títulos de página hardcoded; el detalle de impresora no muestra su nombre en el título. | `TopBar.vue:141` |

---

## Accesibilidad / Design system (mayormente P2)

- A1 (P1) — Modo claro sin colores afinados ni chequeo de contraste WCAG. `plugins/vuetify.ts:40`
- A2 (P2) — Sin "skip to content" para teclado. `App.vue`
- A3 (P2) — Estados de loading de botones inconsistentes (`:loading` vs spinner aparte). varios
- A4 (P2) — Iconos híbridos `md` + `mdi`. `plugins/vuetify.ts:54`
- A5 (P2) — Sin barra de progreso en transición de ruta. `router/`
- A6 (P2) — `setInterval` de retry sin cleanup → fugas. `AppLoader.vue:98`

---

## Plan por fases propuesto

**Fase 0 — Los 2 bugs reportados + quick wins (chico, alta confianza)**
F1, D1, D2, X1. Toast de éxito al imprimir, gate `isPrinting/isPaused` + tooltip,
confirmación al quitar de la cola. Riesgo bajo, impacto inmediato en lo que reportaron.

**Fase 1 — Infraestructura de feedback (fundacional, habilita todo lo demás)**
F2–F6 + F4. Cola de snackbars, severidades (success/info/warning/error) con timeouts
sensatos, `aria-live`, y **surface** de errores HTTP swallowed. Esto resuelve "no da feedback"
de raíz en toda la app.

**Fase 2 — Cola / Dispatch / Intake**
Q1–Q7 + X3, X6, D3. Unificar `QueueFileDialog` ↔ Intake (impresora sugerida, razón de
incompatibilidad clara, loading en submit), consolidar estados de carga.

**Fase 3 — Forms & onboarding**
S1–S7 + X4, X5. Validación inline, feedback de guardado, confirmaciones de seguridad.

**Fase 4 — Grid / Dashboard / Realtime**
G1–G7 + D4, D5. Validar G1 primero; legibilidad de estados, indicadores de offline/stale,
timeouts de cámara.

**Fase 5 — Accesibilidad & pulido**
A1–A6 + X2 + P2 sueltos.
