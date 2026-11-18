# Margen real de Martínez Motos según sus propios datos (CRM ecommanager / Supabase)

Alcance: ventas reales de dic-2025 a 17-nov-2026, consultadas con SQL de solo lectura (solo SELECT) sobre el proyecto Supabase `ulhziakmuwjdkbypwxpz`. No se consultó `meli_tokens` ni ninguna credencial. No hay datos personales: todo está agregado. Fecha de corte: 2026-11-18 (noviembre es parcial, del 1 al 17).

Convención de fuentes: `[tabla](supabase:public.<tabla>)` es una consulta a esa tabla; `[archivo Lnn](file:///home/user/ecommanager/...)` es el código del CRM. Montos en UYU, redondeados.

---

## 1. ¿Cómo calcula el CRM la "Ganancia neta" y qué supuestos usa? (para que los números cierren con lo que ve el vendedor)

### Takeaway
El CRM (Reportes) calcula: ingresos − comisiones − costo de productos (costo × cantidad) − envíos propios (+$75 por colecta) − envíos de devoluciones − costos fijos prorrateados − otros gastos + otros ingresos − Ads con IVA 22%. Reproduje esa fórmula en SQL con cuatro diferencias, todas marcadas: excluyo ventas canceladas, tomo los costos fijos por defecto del código (los reales viven en el navegador), señalo el costo de los packs y señalo las devoluciones.

### Cited Findings
- Fórmula de Reportes: `ganancia = totalIngresos − totalComisiones − costoProductos − totalCostoEnvios − costoEnviosDevol − costosFijosAjustados − otrosMovs.gastos + otrosMovs.ingresos`. El margen se mide contra los ingresos por ventas (los "otros ingresos" no entran al denominador). — [index.html L8898-8923](file:///home/user/ecommanager/public/index.html#L8898)
- Después se le resta el Ads: `gananciaConAds = ganancia − adsConIva(total_spend)`. — [index.html L9174-9178](file:///home/user/ecommanager/public/index.html#L9174)
- Ads con IVA: MELI informa el gasto SIN IVA, pero factura "Cargos por publicidad" con IVA básico 22%. Como la cuenta está en IVA mínimo, ese IVA no se recupera y es costo. Regla del CRM: la plata se cuenta con IVA (×1,22); ROAS, ACOS y CPC se miden sin IVA, como en el panel de MELI. Ejemplo del código: oct-2026 dio $33.297 en la API y $41.024,66 en la factura. — [api/meli/_adsIva.js](file:///home/user/ecommanager/api/meli/_adsIva.js); [index.html L9116-9127](file:///home/user/ecommanager/public/index.html#L9116)
- `ventas.comision` es todo lo que MELI se queda: cargos por venta + cobro de envío − bonificación Flex o envío pagado por el comprador. La parte de envío va desglosada en `ventas.costo_envio_meli`, con signo (+ cobro, − plata a favor) y **ya incluida** en `comision`. La comisión puede quedar negativa. — [api/meli/_envioMeli.js](file:///home/user/ecommanager/api/meli/_envioMeli.js); [api/meli/_economia.js L17-24](file:///home/user/ecommanager/api/meli/_economia.js)
- Los envíos de Mercado Envíos entran a la tabla `envios` con costo 0, porque lo que MELI cobra va en la comisión. Solo los envíos propios (Flex/transportistas) tienen costo en `envios.costo`. — [api/meli/_economia.js L17-28](file:///home/user/ecommanager/api/meli/_economia.js)
- Los envíos se asignan al período por `envios.created_at`, y cada colecta suma $75. — [index.html L8894-8900](file:///home/user/ecommanager/public/index.html#L8894)
- Costos fijos por defecto, en UYU/mes con USD a $42: Claude USD 20, Vercel USD 20, Shopify USD 25, MELI Mi Página $400, **IVA mínimo DGI $1.478 ("Reducido al 25% — sube a 50% y luego a 100%")**, BPS $8.832 (tarifa plena) y gesta.uy $370,18. Total **$13.810/mes**. Se guardan en `localStorage` del navegador, no en la base, y se prorratean por días/30. — [index.html L2430-2478](file:///home/user/ecommanager/public/index.html#L2430); [index.html L8906-8908](file:///home/user/ecommanager/public/index.html#L8906)
- Literal E: tope de 305.000 UI × valor UI 6,6 = $2.013.000 por año calendario. Inicio de actividad 2026-06. MELI y Shopify facturan siempre; el mostrador no factura efectivo ni transferencia. — [index.html L2509-2567](file:///home/user/ecommanager/public/index.html#L2509)
- Las ventas canceladas se mueven a `ventas_canceladas` y salen de `ventas`. Aun así quedan 2 líneas con `estado='cancelada'` en `ventas` ($1.663 en ago y $1.613 en sep). Reportes no filtra por estado, así que el CRM las cuenta; yo las excluí. — [api/ventas.js L37-52, L196-212](file:///home/user/ecommanager/api/ventas.js); [ventas](supabase:public.ventas)
- Costo del producto en Reportes: `productos.costo × v.cantidad`, sin `unidades_por_venta`. El depósito se lleva en unidades sueltas y la venta se cuenta en packs (sliders de a par), y `productos.costo` es por unidad de depósito. — [index.html L8905](file:///home/user/ecommanager/public/index.html#L8905); [api/_packs.js](file:///home/user/ecommanager/api/_packs.js); [public/costo-importacion.js L29-31](file:///home/user/ecommanager/public/costo-importacion.js)

SQL base (resumen) que usé para el P&L mensual:
```sql
-- ventas: v.estado <> 'cancelada'; COGS = coalesce(p.costo,0)*v.cantidad (JOIN productos por sku)
-- cargos MELI por venta = comision - coalesce(costo_envio_meli,0); envío MELI = costo_envio_meli
-- envíos propios = sum(coalesce(envios.costo,0) + 75*colecta) agrupado por to_char(envios.created_at,'YYYY-MM')
-- devoluciones = sum(devoluciones.costo_envio) por created_at
-- ads = sum(meli_ads_diario.spend)*1.22 por mes;  otros = movimientos (tipo gasto/ingreso, monto_uyu)
-- tickets = count(distinct G:venta_grupo | P:pack_id | M:orden_meli | V:id)   (misma regla que ticketKey())
```

### Inferences
- El P&L de abajo replica el número de Reportes con un margen de ±1%. La diferencia sale de las 2 canceladas, de que el prorrateo de fijos sea por 30 o 31 días y de que el vendedor haya editado sus costos fijos en el navegador.
- El IVA mínimo pesa poco hoy ($1.478, 0,7% de la facturación de octubre) porque está reducido al 25%. Al 100% serían ~$5.912/mes (1.478 / 0,25): unos $4.400 más por mes, o −2,0 pts de margen con $220k de facturación.

### Gaps
- No pude leer los costos fijos reales del vendedor, que están en el `localStorage` de su navegador. Usé los valores por defecto del código.
- No hay un campo que diga si MELI reintegró la comisión en las devoluciones.

---

## 2. P&L mensual por capas (como % de la facturación) y comparación con el ~25% que declara

### Takeaway
Con todo descontado, octubre 2026 (último mes completo: $219.506) dejó **$45.902 = 20,9%** de ganancia antes del sueldo del dueño. Corrigiendo los packs y las devoluciones baja a **~19,7%**. El "~25% / ~$50k sobre ~$200k" que declara coincide con lo que el CRM mostraba **antes del 3-nov-2026**, cuando todavía no restaba el envío que cobra MELI (+$8.098 en octubre → 24,6%), y con septiembre ($192.849 → $49.030, 25,4%), que tampoco tiene registrado ese envío. La capa que más creció es Ads: el TACOS pasó de 10% en julio a 18,5% en octubre y 20,5% en noviembre.

### Cited Findings

**P&L mensual, total de los tres canales** (fuente: [ventas](supabase:public.ventas), [productos](supabase:public.productos), [envios](supabase:public.envios), [devoluciones](supabase:public.devoluciones), [meli_ads_diario](supabase:public.meli_ads_diario), [movimientos](supabase:public.movimientos); fijos: [index.html L2430](file:///home/user/ecommanager/public/index.html#L2430))

| Mes | Facturación | MELI / Mostrador / Shopify | Tickets | Ticket prom. | COGS % | **Margen bruto %** | Cargos MELI % | Envío MELI % | Envíos propios % | **CM1 %** | Ads c/IVA (% fact.) | **CM2 % (post-Ads)** | Otros gastos | Fijos | **Ganancia antes sueldo** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-03 | 47.094 | 28.014 / 13.810 / 5.270 | 29 | 1.624 | 25,3 | 74,7 | 8,7 | 0 | 4,3 | 61,7 | sin datos | — | sin datos | — | — |
| 2026-04 | 100.139 | 65.119 / 32.730 / 2.290 | 65 | 1.541 | 25,8 | 74,2 | 9,9 | 0 | 5,3 | 59,0 | sin datos | — | sin datos | — | — |
| 2026-05 | 123.446 | 114.396 / 9.050 / 0 | 83 | 1.487 | 24,6 | 75,4 | 14,1 | 0 | 3,7 | 57,5 | sin datos | — | sin datos | — | — |
| 2026-06 | 106.517 | 103.537 / 2.980 / 0 | 71 | 1.500 | 25,6 | 74,4 | 14,9 | 0 (sin dato) | 0,4 | 59,0 | 4.152 (3,9%; desde el 16/6) | 55,1 | sin datos | 13.810 | 44.934 (42,2%) ⚠️ |
| 2026-07 | 72.051 | 67.261 / 4.790 / 0 | 53 | 1.359 | 28,9 | 71,1 | 14,5 | 0 (sin dato) | 4,8 | 51,8 | 7.296 (10,1%) | 41,7 | sin datos | 13.810 | 16.236 (22,5%) ⚠️ |
| 2026-08 | 130.121 | 125.481 / 4.640 / 0 | 72 | 1.807 | 33,7 | 66,3 | 14,1 | 0 (sin dato) | 4,4 | 47,7 | 17.176 (13,2%) | 34,5 | sin datos | 13.810 | 31.128 (23,9%) ⚠️ |
| 2026-09 | 192.849 | 175.452 / 17.397 / 0 | 116 | 1.662 | 31,6 | 68,4 | 14,1 | 0,3 (parcial) | 6,5 | 47,5 | 28.766 (14,9%) | 32,6 | sin datos | 13.810 | 49.030 (25,4%) ⚠️ |
| **2026-10** | **219.506** | 182.633 / 35.712 / 1.161 | 155 | 1.416 | 28,7 | **71,3** | 12,9 | 3,7 | 6,4 | **48,4** | **40.622 (18,5%)** | **29,9** | 5.866 (2,7%) | 13.810 (6,3%) | **45.902 (20,9%)** |
| 2026-11 (1-17) | 121.775 | 111.633 / 8.684 / 1.458 | 109 | 1.117 | 29,6 | 70,4 | 14,5 | 3,9 | 9,6 (+0,4 devol.) | 42,0 | 24.990 (20,5%) | 21,5 | 6.295 (5,2%) | 7.826 (17/30) | 12.060 (9,9%) |

Notas de la tabla: "Cargos MELI %" y "Envío MELI %" están sobre la facturación total; sobre la facturación MELI son ~15,5% y ~4,4%. ⚠️ = meses sin el envío que cobra MELI y sin otros gastos registrados (ver Gaps). Dic-2025 ($9.633) y ene-2026 ($16.173) tienen volumen mínimo, y feb-2026 no tiene ventas.

**Octubre 2026, capa por capa:**

| Capa | UYU | % facturación |
|---|---|---|
| Facturación (MELI 83,2% · Mostrador 16,3% · Shopify 0,5%) | 219.506 | 100% |
| − Costo de productos (costo × cantidad) | 62.909 | 28,7% |
| = **Margen bruto** | 156.597 | **71,3%** |
| − Cargos por venta MELI (15,5% de la facturación MELI) | 28.340 | 12,9% |
| − Envío cobrado por MELI, neto de bonificación Flex (4,4% de MELI) | 8.098 | 3,7% |
| − Envíos propios (Flex/transportistas + colectas $75) | 13.959 | 6,4% |
| = **Contribución 1** | 106.200 | **48,4%** |
| − Mercado Ads con IVA 22% ($33.297 sin IVA) | 40.622 | 18,5% (TACOS MELI 22,2%) |
| = **Contribución post-marketing** | 65.578 | **29,9%** |
| − Otros gastos (packaging 1.305; envíos por cambios 1.270; 2ª cuota enganche de tráiler 2.300; entradas MELI Experience 990) | 5.866 | 2,7% |
| − Costos fijos (BPS 8.832; IVA mínimo 1.478; software, MELI Mi Página y gesta 3.500) | 13.810 | 6,3% |
| = **Ganancia antes de sueldo del dueño (fórmula CRM)** | **45.902** | **20,9%** |
| − Ajuste packs: COGS × unidades_por_venta (sliders/extensores) | 1.260 | 0,6% |
| − Ajuste devoluciones que siguen contadas como venta (2; margen que se cuenta y no se cobró, cota superior) | 1.460 | 0,7% |
| = **Ganancia ajustada** | **~43.200** | **~19,7%** |
| Sensibilidad: sin BPS (si se considera parte de la retribución del dueño) | +8.832 | ~23,7% |
| Sensibilidad: IVA mínimo al 100% (~5.912) | −4.434 | −2,0 pts |

- Fuente de los otros gastos: concepto por concepto en [movimientos](supabase:public.movimientos). Fuente de los fijos: [index.html L2430-2439](file:///home/user/ecommanager/public/index.html#L2430).
- El ajuste de packs sale de que 18 productos tienen `unidades_por_venta`>1 y el COGS del CRM usa costo × packs. En octubre faltan $1.260 de COGS; en el resto de los meses, $21–$1.080. — [productos](supabase:public.productos); [ventas](supabase:public.ventas)
- Devoluciones: 22 en total. En todas la venta sigue en `ventas` con su facturación completa. El "margen contado" de esas ventas (total − comisión − costo) fue $4.023 (may), $4.349 (jun), $917 (jul), $505 (ago), $549 (sep), $1.460 (oct) y $2.368 (nov). El costo del envío de vuelta solo está cargado en noviembre ($470), y 2 de las de noviembre son por producto equivocado. — [devoluciones](supabase:public.devoluciones)

**Por canal (contribución sin fijos ni otros gastos)** — [ventas](supabase:public.ventas), [envios](supabase:public.envios) unido a `ventas` por `venta_id`, [meli_ads_diario](supabase:public.meli_ads_diario) asignado 100% a MELI:

| Mes | Canal | Facturación | Ticket | MB % | Cargos % | Envío MELI % | Envíos propios % | CM1 % | Ads % | CM2 % |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08 | MELI | 125.481 | 1.819 | 66,3 | 14,6 | 0 (sin dato) | 4,3 | 47,5 | 13,7 | 33,8 |
| 2026-09 | MELI | 175.452 | 1.595 | 68,5 | 15,4 | 0,4 | 7,0 | 45,7 | 16,4 | 29,3 |
| 2026-10 | MELI | 182.633 | 1.343 | 74,0 | 15,4 | 4,4 | 6,2 | 47,9 | 22,2 | **25,6** |
| 2026-10 | Mostrador | 35.712 | 1.984 | 58,1 | 0,5 | — | 6,6 | 51,0 | — | **51,0** |
| 2026-10 | Shopify | 1.161 | 1.161 | 65,1 | 0 | — | 16,8 | 48,3 | — | 48,3 |
| 2026-11 | MELI | 111.633 | 1.105 | 70,2 | 15,8 | 4,3 | 9,7 | 40,4 | 22,4 | **18,0** |
| 2026-11 | Mostrador | 8.684 | 1.241 | 72,9 | 0 | — | 9,8 | 63,1 | — | 63,1 |

- Los descuentos de mostrador fueron $2.891 en octubre (7,5% del bruto) y $756 en noviembre. — [ventas](supabase:public.ventas) (`descuento_monto`)
- Ads, del panel MELI sin IVA: octubre $33.297 de gasto contra $145.690 de facturación atribuida → ACOS 22,9% / ROAS 4,38. Con IVA, el costo real es 27,9% de lo atribuido. La facturación atribuida a Ads fue 80% de la facturación MELI en septiembre y octubre (38% en julio, 52% en agosto). — [meli_ads_diario](supabase:public.meli_ads_diario)
- Evolución del gasto en Ads con IVA: jun (desde el 16) 4.152 → jul 7.296 → ago 17.176 → sep 28.766 → oct 40.622 → nov 1-17 24.990. La facturación MELI fue 67k → 125k → 175k → 183k → 112k en el mismo período. — [meli_ads_diario](supabase:public.meli_ads_diario); [ventas](supabase:public.ventas)
- El CRM define el ROAS de equilibrio como 1,22 / margen de contribución. — [index.html L9116-9121](file:///home/user/ecommanager/public/index.html#L9116); [api/meli/_economia.js L1-15](file:///home/user/ecommanager/api/meli/_economia.js)
- El código que suma a la comisión el envío que paga el vendedor (y la bonificación Flex) es del 3-nov-2026. Octubre y noviembre tienen comisiones reales (0 líneas con 15% plano). De diciembre a septiembre, entre 50% y 100% de las líneas MELI tienen una comisión exactamente igual al 15% del total, lo que indica una comisión estimada. — `git log api/meli/_envioMeli.js`; [ventas](supabase:public.ventas)

### Inferences
- **El ~25% del vendedor viene de datos incompletos, no de cuentas mal hechas.** Antes del arreglo del 3-nov, el CRM no restaba el envío que cobra MELI (~4,4% de la facturación MELI). Octubre sin ese costo daba $54.000 (24,6%), y septiembre daba $49.030 sobre $192.849 (25,4%): son casi exactamente el "≈$50k sobre ≈$200k" que describe. Con los datos de hoy, octubre da 20,9%, o ~19,7% con los ajustes.
- Estimación de jun–sep corregidos por el envío MELI faltante (4,4% de la facturación MELI): jul ~18,4%, ago ~19,7% y sep ~21,8%. Además faltan ~$1–3k/mes de packaging y envíos por cambios, que recién se registran desde octubre. Junio (42%) no es comparable: le falta medio mes de Ads, el envío MELI y los otros gastos. Es decir, **el margen real antes de sueldo anduvo entre 18% y 22% de julio a octubre, y no subió con el volumen.**
- Ads es la palanca principal. De septiembre a octubre el gasto en Ads subió +$11.856 (con IVA) y la facturación MELI solo +$7.181: el retorno marginal del último tramo de Ads fue negativo en contribución. El ROAS promedio (4,38 sin IVA) sigue arriba del equilibrio (1,22 / 0,479 ≈ 2,55), así que el Ads paga en promedio, pero el gasto adicional no.
- Noviembre viene peor (CM2 de MELI 18,0%, ganancia ~10% del mes en curso). Las causas: el ticket promedio bajó a $1.117, los envíos propios subieron a 9,7% de MELI y Ads se mantuvo en 22%.
- El mostrador es el canal más rentable por peso facturado (CM 51–63%, sin comisión ni Ads), pero es ~16% del volumen en octubre y ~7% en noviembre.
- Literal E (inferencia con las reglas del CRM): lo facturable de 2026 suma ~$1,02M en el año calendario, o ~$0,77–0,78M desde junio, contra un tope de $2.013.000. El ritmo de octubre (~$184k facturables/mes) anualiza a ~$2,2M, **arriba del tope**. Si 2027 sigue a ese ritmo, cambia el régimen: IVA 22% sobre ventas, pero con crédito por el IVA de Ads e importaciones. Eso cambia toda la estructura de margen. — [ventas](supabase:public.ventas) (canal, metodo_pago, facturada); [index.html L2509-2567](file:///home/user/ecommanager/public/index.html#L2509)

### Gaps
- Envío que cobra MELI: no está registrado de dic-2025 a ~sep-2026. Las comisiones de esos meses son en buena parte un 15% plano estimado.
- Ads: hay datos diarios desde el 16-jun-2026. La tabla `meli_ads_snapshots_legacy` (mar–sep) tiene snapshots acumulados por campaña, no gasto diario, y no sirve para armar un mensual.
- Otros gastos (`movimientos`): solo existen desde oct-2026.
- Envíos propios: se toma el costo cargado en `envios`. Los pagos a transportistas (`pagos_transportistas`: oct $11.410, nov $12.544) andan cerca, pero no los concilié uno por uno. En octubre hay además "UES facturas pendientes septiembre" ($709) cargado como movimiento, que puede ser un costo de septiembre no registrado en `envios`.
- Comisiones de Shopify y POS del mostrador: casi no hay registro (comisión de mostrador $175 en octubre).

---

## 3. ¿`productos.costo` ya es el costo puesto en Uruguay (~2,25x el precio en China)?

### Takeaway
**Sí, en la mayoría de los casos.** Para los SKUs que explican el 64,5% de la facturación oct–nov, `productos.costo` es **exactamente** el costo en China (USD, de la PI en `importaciones.items`) × 2,25 × $40/USD. Es el factor del esquema viejo (con IVA) que documenta el propio código. Hay 6 SKUs (17,6% de la facturación) con un costo cargado bastante menor que 2,25x y 3 SKUs (6,0%) con uno mayor. Si se aplica 2,25x literal a todos los SKUs con importación, el margen bruto de oct–nov baja de 71,0% a 59,6%. Casi toda esa diferencia viene de 3 guardamanos, un guardabarros y unos espejos de puño, donde probablemente el renglón de la PI está por set o pack: hay que verificarlo con la PI. Para adelante es al revés: la importación del 11-nov usa un factor de 1,37x y, cuando entre por PPP, el margen bruto de esos SKUs sube.

### Cited Findings
- El código documenta los dos esquemas: "factor = costo total ÷ costo en China (≈ 1,37 en la primera carga; con el esquema anterior, que pagaba IVA, se usaba 2,25)". Desde nov-2026 se importa con GrupoRAS FOB Guangzhou (all in del importador, sin IVA). Al llegar, el costo de cada SKU se actualiza por PPP (precio promedio ponderado). `productos.costo` es por unidad de depósito y la cotización por defecto es $40. — [public/costo-importacion.js L1-45](file:///home/user/ecommanager/public/costo-importacion.js)
- El PPP nunca se aplicó: las 10 importaciones tienen `costos_aplicados` = null. La única con el esquema nuevo (2026-11-11, estado "ordered") tiene costo en China USD 1.128,9, puesta en puerto 1.524,9, traslado 21,1 y **factor 1,369**. Las 9 importaciones del esquema viejo (feb–oct 2026) tienen total/China entre ~2,1x y ~3,2x (con IVA 22% incluido en `total`), salvo una (22-jun) con ~1,0x. — [importaciones](supabase:public.importaciones)
- Coincidencias exactas `costo = china_usd × 2,25 × 40` (factor implícito 2,25): HSJ-20121 (3,8 → $342), ALERONFINOSNK (3,7 → $333), CPJ-62001 (4,5 → $405), 2004-107 (5,5 → $495), PATENTE1 (1,2 → $108), AP-YOSHIMURA01 (28,4 → $2.556), HS-30006, DOM00/01/02. Muy cerca (2,19–2,37): FSB-002/003, ESP-CIR-001, SOP-CEL-*, MAN-78-V2, YTLY-30, EXT-ESP. En total, $220.181 de $341.281 facturados del 1/10 al 17/11 (64,5%). — [productos](supabase:public.productos) × [importaciones](supabase:public.importaciones) (último renglón del esquema viejo por SKU) × [ventas](supabase:public.ventas)
- Costo cargado **menor** que 2,25x ($59.954 facturados, 17,6%):
  - HP-Q0211/Q0212/Q0213 guardamanos: PI USD 15,09 → 2,25x = $1.358, cargado $277 (factor 0,46). Se venden a $642–711.
  - HP-DB004-B guardabarros: PI USD 14,625 → $1.316, cargado $623 (1,06).
  - HP-SH-5003-L espejos de puño: PI USD 8,55 → $770, cargado $416 (1,22).
  - HP-EXHAUST-GSILVER: PI → $1.215, cargado $900 (1,67).
- Costo cargado **mayor** que 2,25x ($20.429, 6,0%): AP-TAILBOXSQ baúl 45L (3,00), PUNBLACK (3,52), HP-Q035B1 (3,13). Sin ningún renglón de importación: $40.720 facturados (11,9%).
- El factor implícito ponderado por facturación es 2,06 (mediana 2,19) con $40/USD.
- Recalculado con 2,25x para todos los SKUs con importación (1/10–17/11): el COGS pasa de $98.906 a $137.740 con $40/USD (margen bruto **71,0% → 59,6%**, −11,4 pts) o a $144.051 con $42/USD (57,8%). De los +$38.834, ~$22.700 son de los 3 guardamanos, ~$9.000 del guardabarros y ~$8.100 de los espejos de puño.
- Esquema nuevo (importación del 11-nov, 15 SKUs con match, que facturaron $188.978 = 55% de oct–nov): a costo China × 1,369 × 40, el COGS de esos SKUs pasaría de $45.137 a $26.851 y su margen bruto de **76,1% a 85,8%**. El valor de la mercadería que llega baja de $84.708 a $49.443 (costo viejo contra nuevo). — [importaciones](supabase:public.importaciones); [productos](supabase:public.productos); [ventas](supabase:public.ventas)

### Inferences
- El dato del vendedor (~2,25x) coincide con lo que tiene cargado. El margen bruto de ~71% del P&L **ya es con costo puesto en Uruguay (con IVA de importación)**, no con precio de China, así que no hace falta recalcular el P&L general.
- Los guardamanos HP-Q021x son el caso más grave. Si el costo real fuera 2,25 × 15,09 USD ($1.358), se estarían vendiendo a la mitad del costo. Lo más probable es que el renglón de la PI sea por pack o set y el costo cargado ($277 ≈ 3,08 USD × 90) sea por unidad, pero hay que confirmarlo con la PI. Lo mismo aplica al guardabarros HP-DB004-B y a los espejos de puño HP-SH-5003-L.
- El cambio de esquema (2,25x → ~1,37x) es la mayor mejora de margen que tiene a la vista: unos +5 pts sobre la facturación total cuando el stock nuevo reemplace al viejo (−$18.286 de COGS en la ventana oct–nov, sobre $341k). Va a entrar de a poco, porque el PPP mezcla el stock viejo con el que llega. Ojo: con 1,37x no se paga el IVA de importación, y en IVA mínimo ese IVA era costo.

### Gaps
- No pude confirmar la unidad (pieza, par o set) de los renglones de la PI de los SKUs con discrepancia. La tabla guarda solo `qty`, `sku`, `costo` y `nombre`.
- `productos.costo` es el costo actual, no el histórico: se aplica hacia atrás a todos los meses.
- La cotización usada en los costos es $40/USD. El CRM usa $42 por defecto para los costos fijos en USD.

---

## 4. Margen por grupo de producto (últimos 3 meses)

### Takeaway
Espejos es el corazón del negocio: 38% de la facturación en 3 meses y 50% en oct–nov, con 33% de contribución después de Ads. Baúles, Soportes y Puños tienen la mejor contribución porcentual. Manillares, Carenado y Escapes contribuyen poco por exceso de Ads (Manillares), costo alto (Carenado) o precio cercano al costo (Escapes). Entre agosto y octubre el mix pasó de baúles de ticket alto (16% de la facturación en 3 meses, 4% en oct–nov) a espejos de ~$1.400.

### Cited Findings
Ventana A = 18/8–17/11 (3 meses; sin el envío MELI antes de octubre). Ventana B = 1/10–17/11 (datos completos: envío MELI real, Ads por SKU). El envío propio se prorratea por ticket según el total de cada línea, como hace el CRM en el margen por venta. Ads por SKU: `meli_ads_anuncios` (cubre ~60% del gasto diario), escalado al total de `meli_ads_diario` × 1,22. — [ventas](supabase:public.ventas), [envios](supabase:public.envios), [meli_ads_anuncios](supabase:public.meli_ads_anuncios), [meli_ads_diario](supabase:public.meli_ads_diario), [productos](supabase:public.productos)

| Grupo | Fact. 3m | % 3m | MB % 3m | CM1 % 3m* | Fact. oct–nov | % oct–nov | Precio prom. | MB % | Cargos % | Envío MELI % | Envío propio % | CM1 % | Ads c/IVA | TACOS % | **CM2 %** | CM2 $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Espejos | 224.878 | 38,0 | 75,4 | 52,9 | 171.392 | 50,2 | 1.416 | 75,0 | 12,9 | 3,8 | 6,4 | 52,0 | 32.254 | 18,8 | **33,1** | 56.808 |
| Matrícula | 56.664 | 9,6 | 73,6 | 46,2 | 40.772 | 11,9 | 1.102 | 72,0 | 14,1 | 7,8 | 6,4 | 43,7 | 9.030 | 22,1 | 21,6 | 8.794 |
| Protección | 46.297 | 7,8 | 67,8 | 33,8 | 36.587 | 10,7 | 832 | 67,9 | 16,8 | 10,4 | 8,0 | 32,7 | 3.874 | 10,6 | 22,1 | 8.076 |
| Manillares | 23.106 | 3,9 | 78,0 | 53,7 | 21.989 | 6,4 | 1.047 | 78,0 | 14,3 | 1,9 | 8,5 | 53,3 | 8.194 | **37,3** | 16,0 | 3.516 |
| Carenado | 42.447 | 7,2 | 59,5 | 37,1 | 18.925 | 5,5 | 1.352 | 51,9 | 14,7 | 5,3 | 5,0 | 26,8 | 3.481 | 18,4 | 8,4 | 1.596 |
| Baúles | 96.259 | 16,3 | 70,3 | 53,5 | 15.008 | 4,4 | 3.752 | 74,7 | 11,2 | 3,2 | 3,3 | 57,1 | 0 | 0 | **57,1** | 8.563 |
| Puños | 20.785 | 3,5 | 69,6 | 39,3 | 13.095 | 3,8 | 689 | 71,6 | 14,1 | 1,3 | 12,9 | 43,3 | 1.393 | 10,6 | 32,6 | 4.272 |
| Soportes y bases | 39.427 | 6,7 | 67,3 | 42,2 | 12.827 | 3,8 | 428 | 79,8 | 16,8 | −19,2 | 26,3 | 55,9 | 1.369 | 10,7 | 45,2 | 5.800 |
| Escapes | 33.429 | 5,6 | 42,8 | 30,6 | 10.366 | 3,0 | 2.591 | **17,3** | 3,4 | −0,3 | 4,1 | 10,2 | 0 | 0 | 10,2 | 1.055 |
| Eléctrico | 6.295 | 1,1 | 28,6 | 0,1 | 320 | 0,1 | 320 | 26,3 | 19,7 | −62,5 | 85,9 | −16,9 | 0 | 0 | −16,9 | −54 |
| Posapiés | 2.591 | 0,4 | 50,5 | 35,5 | — | — | — | — | — | — | — | — | — | — | — | — |
| Ads sin SKU / sin grupo | — | — | — | — | — | — | — | — | — | — | — | — | 6.016 | — | — | −6.016 |

\* CM1 3m queda sobreestimado en ago–sep porque falta el envío MELI. Total ventana B: facturación $341.281, CM2 ≈ $92.400 (27,1%), coherente con el P&L mensual (oct 65.578 + nov 26.181).

### Inferences
- Un envío MELI negativo (Soportes, Eléctrico) es plata que MELI le pasa al vendedor por envíos Flex que paga el comprador. Ese crédito queda chico al lado del envío propio de esos ítems baratos (26–86% del precio).
- Escapes (margen bruto 17% en oct–nov) es sobre todo ventas de mostrador del Yoshimura a $2.667 con costo $2.556: casi a costo.
- Manillares gasta en Ads 37% de lo que factura: su contribución cae de 53% a 16%. Es el candidato más claro a bajar el ROAS objetivo o pausar campañas.

### Gaps
- `meli_ads_anuncios` existe solo desde octubre y cubre ~60% del gasto diario: el Ads por grupo es una asignación escalada, no una medición exacta. Además, $6.016 (con IVA) de Ads en oct–nov no tienen SKU asignado.
- Los grupos con 1 a 5 unidades en la ventana (Eléctrico, Posapiés, Baúles en oct–nov) son estadísticamente débiles.

---

## 5. Top 10 y bottom 10 SKUs por contribución (1/10–17/11, después de Ads)

### Takeaway
Dos espejos tipo alerón (HSJ-20121 y ALERONFINOSNK) generan ~$47k de los ~$92k de contribución post-Ads de la ventana: la mitad del negocio. Los peores SKUs son de dos tipos: ítems baratos con Ads desproporcionado (TACOS 70–88%) y guardamanos donde el envío que cobra MELI se come 15–30% del precio.

### Cited Findings
Misma metodología que la sección 4 (envío prorrateado por ticket, Ads por SKU escalado, con IVA). — [ventas](supabase:public.ventas), [productos](supabase:public.productos), [envios](supabase:public.envios), [meli_ads_anuncios](supabase:public.meli_ads_anuncios), [meli_ads_diario](supabase:public.meli_ads_diario)

**Top 10 por contribución en $ después de Ads**

| # | SKU | Producto | Grupo | Uds | Facturación | % MELI | Precio | MB % | Cargos % | Envío MELI % | Envío propio % | CM1 % | Ads $ | TACOS % | CM2 $ | CM2 % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | HSJ-20121 | Espejos tipo alerón grande aluminio | Espejos | 55 | 83.879 | 80 | 1.525 | 77,6 | 12,0 | 3,2 | 6,3 | 56,0 | 9.703 | 11,6 | **37.294** | 44,5 |
| 2 | ALERONFINOSNK | Espejos alerón finos naked | Espejos | 29 | 41.912 | 97 | 1.445 | 77,0 | 14,3 | 4,8 | 5,3 | 52,6 | 12.458 | 29,7 | 9.577 | 22,8 |
| 3 | AP-TAILBOXSQ | Baúl trasero 45L | Baúles | 4 | 15.008 | 76 | 3.752 | 74,7 | 11,2 | 3,2 | 3,3 | 57,1 | 0 | 0 | 8.563 | 57,1 |
| 4 | CPJ-62001 | Porta matrícula rebatible | Matrícula | 25 | 30.488 | 89 | 1.220 | 66,8 | 13,2 | 4,8 | 5,8 | 43,0 | 5.844 | 19,2 | 7.275 | 23,9 |
| 5 | 2004-107 | Espejos alerón deportivas | Espejos | 5 | 11.263 | 82 | 2.253 | 78,0 | 12,1 | 0,2 | 7,0 | 58,7 | 801 | 7,1 | 5.808 | 51,6 |
| 6 | FSB-002 | Slider aluminio grande (par) | Protección | 6 | 7.572 | 100 | 1.262 | 85,7† | 14,9 | 6,7 | 4,4 | 59,7 | 965 | 12,7 | 3.558 | 47,0 |
| 7 | SOP-CEL-MAN-001 | Soporte celular manillar | Soportes | 13 | 6.046 | 85 | 465 | 81,1 | 15,0 | −14,5 | 20,7 | 59,9 | 557 | 9,2 | 3.064 | 50,7 |
| 8 | HP-SH-5003-L | Espejos de puño aluminio | Espejos | 23 | 26.781 | 91 | 1.164 | 64,3‡ | 13,4 | 4,8 | 7,7 | 38,4 | 7.303 | 27,3 | 2.976 | 11,1 |
| 9 | HP-DB004-B | Guardabarros trasero ABS | Carenado | 13 | 16.135 | 100 | 1.241 | 49,8‡ | 14,7 | 6,6 | 3,6 | 24,9 | 1.433 | 8,9 | 2.580 | 16,0 |
| 10 | SOP-CEL-ESP-001 | Soporte celular espejo | Soportes | 12 | 5.502 | 100 | 458 | 80,8 | 17,8 | −24,6 | 30,6 | 57,0 | 652 | 11,8 | 2.485 | 45,2 |

**Bottom 10 por contribución % después de Ads**

| # | SKU | Producto | Uds | Facturación | Precio | MB % | Envío MELI % | Envío propio % | CM1 % | Ads $ | TACOS % | CM2 $ | CM2 % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | MAN-78-V3-NEG-001 | Manillar café racer 7/8 | 2 | 1.666 | 833 | 68,4 | −12,0 | 12,0 | 48,6 | 1.463 | **87,8** | −653 | −39,2 |
| 2 | HP-DF028 | Parabrisas universal 45cm | 1 | 2.790 | 2.790 | 64,2 | −2,1 | 13,1 | 38,2 | 2.048 | **73,4** | −984 | −35,3 |
| 3 | HP-Z0533 | Señaleros LED finos | 1 | 320 | 320 | 26,3 | −62,5 | 85,9 | −16,9 | 0 | 0 | −54 | −16,9 |
| 4 | DOM04 | Puños Domino | 1 | 450 | 450 | 74,0 | 0 | 0 | 55,7 | 317 | 70,3 | −66 | −14,7 |
| 5 | HP-HS010 | Guardamanos con señalero LED | 7 | 6.608 | 944 | 58,9 | **15,3** | 12,2 | 12,2 | 1.503 | 22,7 | −699 | −10,6 |
| 6 | AP-YOSHIMURA01 | Escape Yoshimura (mostrador) | 3 | 8.000 | 2.667 | **4,2** | 0 | 3,2 | 1,0 | 0 | 0 | 79 | 1,0 |
| 7 | HP-Q0212 | Guardamanos enduro/cross | 3 | 1.927 | 642 | 56,9‡ | **29,6** | 0 | 8,4 | 0 | 0 | 162 | 8,4 |
| 8 | HP-Q0213 | Guardamanos enduro/cross | 7 | 4.979 | 711 | 61,1‡ | **22,9** | 9,8 | 9,4 | 0 | 0 | 468 | 9,4 |
| 9 | PUNYELLOW | Puños con contrapeso | 3 | 2.841 | 947 | 81,0 | −1,0 | 20,4 | 48,7 | 1.077 | 37,9 | 307 | 10,8 |
| 10 | HP-SH-5003-L | Espejos de puño aluminio | 23 | 26.781 | 1.164 | 64,3‡ | 4,8 | 7,7 | 38,4 | 7.303 | 27,3 | 2.976 | 11,1 |

† FSB-002 se vende de a par (`unidades_por_venta`=2). Su margen bruto con costo × 2 sería ~71%, no 85,7%.
‡ SKUs con costo cargado menor que 2,25x la PI (sección 3). Si la PI estuviera bien, su margen real sería mucho peor.

### Inferences
- Los bottom 1, 2 y 4 son casos de Ads gastando sobre 1 a 2 ventas. Eso es configuración de campañas, no un problema de producto.
- En los guardamanos (HP-HS010, HP-Q0212, HP-Q0213), MELI cobra un envío de 15–30% del precio aunque se venden a $640–950. Con ese envío y el costo en duda, son los candidatos a subir precio o a venderse en kit.
- HP-SH-5003-L aparece en las dos listas: deja plata en $ por volumen, pero solo 11% sobre facturación (TACOS 27%).

### Gaps
- Con 7 semanas de datos limpios, la mayoría de los SKUs tienen menos de 10 unidades: el ranking de los bottom es frágil.

---

## 6. Margen según precio de venta y ticket promedio

### Takeaway
La contribución por unidad crece mucho con el precio: $156 por unidad bajo $500 contra $1.032 por unidad sobre $2.000. En porcentaje, el mejor tramo es $1.200–1.999 (CM2 34%, la mitad de la facturación). El tramo de $800–1.199 es el más castigado: Ads 19,5% de lo que factura y CM2 21%. El ticket promedio bajó de $1.807 (agosto) a $1.416 (octubre) y $1.117 (noviembre).

### Cited Findings
Ventana 1/10–17/11, tramo según precio unitario efectivo (total / cantidad). Misma metodología que la sección 4. Los Ads de cada SKU se reparten entre sus líneas MELI según su facturación. — [ventas](supabase:public.ventas), [productos](supabase:public.productos), [envios](supabase:public.envios), [meli_ads_anuncios](supabase:public.meli_ads_anuncios), [meli_ads_diario](supabase:public.meli_ads_diario)

| Tramo de precio | Uds | Facturación | % fact. | % MELI | Precio prom. | MB % | Cargos % | Envío MELI % | Envío propio % | CM1 % | Ads % | **CM2 %** | **CM2 $/ud** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| < $500 | 43 | 16.282 | 4,8 | 88 | 379 | 73,9 | 16,0 | −16,3 | 22,7 | 51,6 | 10,4 | 41,2 | **156** |
| $500–799 | 26 | 16.912 | 5,0 | 77 | 650 | 63,9 | 14,4 | **10,9** | 10,4 | 28,2 | 1,9 | 26,4 | 171 |
| $800–1.199 | 96 | 100.727 | 29,5 | 91 | 1.049 | 69,8 | 14,7 | 5,8 | 8,4 | 40,9 | **19,5** | 21,3 | 224 |
| $1.200–1.999 | 116 | 167.934 | 49,2 | 89 | 1.448 | 74,8 | 13,3 | 4,4 | 5,6 | 51,4 | 17,2 | **34,2** | 495 |
| ≥ $2.000 | 14 | 39.426 | 11,6 | 65 | 2.816 | 59,8 | 9,7 | 1,1 | 5,2 | 43,9 | 7,2 | 36,6 | **1.032** |

Ticket promedio (tickets = compra completa según `ticketKey`), total de canales: mar 1.624 · abr 1.541 · may 1.487 · jun 1.500 · jul 1.359 · ago 1.807 · sep 1.662 · **oct 1.416** · **nov 1.117**. MELI en octubre: $1.343, mostrador: $1.984. — [ventas](supabase:public.ventas); [index.html L7490-7507](file:///home/user/ecommanager/public/index.html#L7490)

- Líneas MELI con precio ≥ $1.500: 50 de 115 en septiembre, 30 de 145 en octubre, 4 de 105 en noviembre. — [ventas](supabase:public.ventas)

### Inferences
- Bajo $800, el problema no es el % (CM2 26–41%) sino el valor absoluto: $156–171 por unidad no alcanza para cubrir el tiempo de preparación ni los costos fijos. Para pagar los $13.810 de fijos hacen falta ~85 unidades de ese tramo, contra ~28 de $1.200–1.999.
- En $500–799, el envío que cobra MELI (10,9%) más el envío propio (10,4%) suman 21% del precio. Ese es el tramo donde más pesa el envío.
- El tramo de $800–1.199 concentra el gasto en Ads (19,5% de lo que factura). Ahí es donde el TACOS alto más deprime el margen.
- La caída del ticket promedio en noviembre ($1.117) explica buena parte de la baja de margen del mes: entran más unidades baratas con el mismo costo de envío y de Ads.

### Gaps
- No tengo el umbral exacto de envío gratis de MLU en la base: el campo `productos.envio_gratis` es nuevo (migración 2026-11-13) y no lo analicé.
- Con 14 unidades, el tramo ≥ $2.000 tiene muestra chica y está mezclado con ventas de mostrador (35%).
