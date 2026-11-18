# Mercado Libre Uruguay (MLU): especificidades para una estrategia de multipublicación, y contraste con Argentina (MLA)

Nota de método (17-nov-2026): en esta sesión no se pudo leer ninguna página completa. `api.mercadolibre.com/sites/MLU/listing_types` (y el resto de endpoints públicos de `/sites/MLU`) devolvió **403 PolicyAgent "PA_UNAUTHORIZED_RESULT_FROM_POLICIES"**. mercadolibre.com.uy devolvió 403 al pedir páginas. academia.nubimetrics.com y thelogisticsworld.com no resolvieron porque están fuera de los dominios de red permitidos. El conector MCP de MercadoLibre necesita que el usuario vuelva a iniciar sesión. Por eso casi todos los hallazgos salen de extractos de páginas que devolvió el buscador, no de una lectura completa. Hay que revalidar las cifras clave (comisiones, umbral de envío gratis, costo de cuotas) en el simulador de costos de MLU con una cuenta de vendedor.

---

## 1. Tipos de publicación en Uruguay (Gratuita / Clásica / Premium): comisiones, costos fijos y qué incluye cada uno

### Takeaway
MLU tiene los mismos tres niveles que MLA: Gratuita, Clásica (gold_special) y Premium (gold_pro). En las categorías que aparecen en la ayuda oficial, Premium cuesta unos **2 puntos porcentuales más** que Clásica (11% contra 13% en celulares, notebooks y TV). Lo que justifica pagar Premium es la exposición "Máxima" y las **cuotas sin interés** (la tabla oficial tiene una fila "Ofreces 12 cuotas sin interés"). El costo fijo vigente según la ayuda es de **$U 15 por unidad en productos de menos de $U 400**. Una fuente de terceros menciona un mínimo de $U 50 / $U 20 desde agosto de 2025, que contradice a la ayuda oficial.

### Cited Findings
- Publicar es gratis y el costo se cobra al vender. Hay tres tipos de publicación: la **Gratuita** tiene exposición baja y dura **60 días**, y **Clásica y Premium no tienen límite de duración**. Premium da "la mayor exposición" ("Máxima" frente a "Alta" de Clásica) y **permite cuotas sin interés**. — [Mercado Libre UY, Ayuda: Costos de vender un producto](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- El cargo por venta es un porcentaje que depende de la categoría. Ejemplos de la tabla oficial: **Celulares y Smartphones, Notebooks y Televisores: 11% en Clásica y 13% en Premium**; **Libros: 12,5% en Clásica y 14,5% en Premium**. La página no muestra fecha de vigencia. — [Mercado Libre UY, Ayuda 870](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- **Costo fijo:** en productos de **menos de $ 400 (UYU) se suman $ 15 por unidad** al cargo por venta, tanto en Clásica como en Premium. No se aplica a Libros. — [Mercado Libre UY, Ayuda 870](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- La tabla oficial tiene una fila **"Ofreces 12 cuotas sin interés"**, pero el extracto no muestra sus valores por columna. Esto indica que el beneficio de cuotas de Premium en UY se presenta como 12 cuotas. — [Mercado Libre UY, Ayuda 870](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- El Centro de Vendedores de MLU tiene notas oficiales sobre cómo funcionan los costos, el simulador de costos y el reporte de facturación. — [Cómo funcionan los costos de Mercado Libre (UY)](https://vendedores.mercadolibre.com.uy/nota/como-funcionan-los-costos-de-mercado-libre); [Cómo usar el simulador de costos (UY)](https://vendedores.mercadolibre.com.uy/nota/como-usar-el-simulador-de-costos-de-mercado-libre); [Reporte de Facturación (UY)](https://vendedores.mercadolibre.com.uy/nota/como-se-compone-el-reporte-de-facturacion-de-mercado-libre)
- Hay una página de ayuda aparte sobre **comisiones por cobro** (Mercado Pago) en MLU. Su contenido no se pudo leer. — [Mercado Libre UY, Ayuda 33400](https://www.mercadolibre.com.uy/ayuda/33400)
- La página "Costos por vender" de **developers.mercadolibre.com.uy** muestra ejemplos en **pesos argentinos**. Es una copia de la documentación de MLA y no sirve para calcular costos de MLU. — [developers.mercadolibre.com.uy: comisión por vender](https://developers.mercadolibre.com.uy/es_ar/comision-por-vender)
- **Dato en conflicto:** un blog de un proveedor de software afirma que **desde agosto de 2025** MLU cobra a los vendedores uruguayos un **cargo mínimo de 50 UYU por publicación (20 UYU en categorías de consumo masivo)**. Otra guía de 2025 dice que **50 pesos es el precio mínimo para vender** en Uruguay. Ninguna de las dos es oficial, y las dos chocan con el "costo fijo de $15 bajo $400" de la ayuda oficial. — [WooSync blog (2026)](https://www.woosync.io/blog/mercado-envios-desembarca-en-uruguay/); contradicho por [Mercado Libre UY, Ayuda 870](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- **Contraste con MLA:** en Argentina, según la documentación de developers, las publicaciones **gold_special (Clásica) solo tienen las cuotas con interés que ofrecen los bancos**, y se paga solo el cargo por vender más el costo fijo si corresponde. — [developers.mercadolibre.com.ar: campaña con cuotas para marketplace](https://developers.mercadolibre.com.ar/campana-con-cuotas-para-marketplace)

### Inferences
- La brecha Clásica/Premium en MLU (unos 2 pp en las categorías que se ven) parece **más chica** que el costo de financiar cuotas en MLA (ver sección 2). Si se confirma, la dupla "Clásica + Premium" sale más barata como palanca de multipublicación en UY que en AR.
- El costo fijo de MLU solo pesa en tickets muy bajos (menos de $U 400, unos US$ 10 con el tipo de cambio de la sección 6). La estrategia de "kits" para pasar el umbral del costo fijo, muy usada en AR, solo tiene sentido en UY para productos de menos de unos $U 400.
- MLU conserva la **Gratuita** (60 días, exposición baja). Puede servir como tercera variante de prueba, aunque con poca visibilidad.

### Gaps
- No se pudo leer la tabla completa de comisiones de MLU por categoría ni su fecha de vigencia. La API `listing_types` / `listing_prices` para MLU devolvió 403.
- No hay confirmación de que la comisión de MLU se facture más IVA (22%), como en AR, donde se suma el IVA del 21% sobre la comisión. Tampoco de si cambió en 2025-2026.
- No se pudo verificar el supuesto "mínimo de 50/20 UYU desde agosto de 2025" (WooSync). Hay que validarlo en el simulador oficial.

---

## 2. Cuotas en Uruguay: tarjetas, cantidad habitual, quién paga, control por publicación y peso para el comprador uruguayo frente al argentino

### Takeaway
En MLU las cuotas sin interés van atadas a **Premium**, con un techo publicitado de **"hasta 12 cuotas sin interés"**. En los listados también aparecen ofertas de 10 cuotas. Las tarjetas relevantes son **OCA, Creditel, Lider, Visa, Mastercard y Diners**. Las emisoras locales (OCA, Creditel) son protagonistas, a diferencia de AR, donde mandan los bancos. El costo para el vendedor uruguayo parece mucho menor que en AR: una fuente secundaria habla de **hasta ~4%** por 3 a 12 cuotas en UY, frente al **7-22%** estimado en AR. No se encontró documentación de MLU que permita elegir el plan de cuotas publicación por publicación, como en las "campañas de cuotas" de MLA.

### Cited Findings
- La ayuda oficial de MLU indica que con tarjeta de crédito se puede pagar en **hasta 12 cuotas sin interés**, y lista entre los medios a **Visa, Mastercard, Diners, OCA, Lider y Creditel**. — [Mercado Libre UY, Ayuda: Cómo pagar tu compra](https://www.mercadolibre.com.uy/ayuda/a-pagar-tu-compra_2827)
- Tabla de cuotas sin interés por tarjeta en Mercado Pago UY según una guía de terceros (fecha incierta, versión antigua de 2023): **Creditel 14, Scotiabank 12, OCA 12, Mastercard 12, Lider 12, Visa 10, Diners 6**. Puede estar desactualizada. — [Finanzas.com.uy: Mercado Pago](https://finanzas.com.uy/mercadopago/); [Finanzas.com.uy (2023)](https://finanzas.com.uy/mercado-pago-conoce-todos-las-formas-de-pagar-en-uruguay-2023/)
- En listados reales de MLU se ven textos como **"10 cuotas de $827,90 sin interés"** junto a "Envío gratis", y también "hasta 12 cuotas sin interés", a veces con la aclaración "con bancos seleccionados". — [Listado MLU: sillas de auto](https://listado.mercadolibre.com.uy/bebes/paseo-bebe/sillas-autos/); [Mercado Libre UY, Ayuda 870](https://www.mercadolibre.com.uy/ayuda/precios_de_tipos_de_publicaci%C3%B3n_870)
- **Costo para el vendedor en UY (fuente secundaria, 2025, solo extracto):** ofrecer **de 3 a 12 cuotas sin interés puede implicar un cargo de hasta un 4%** del valor del producto, y "para cuotas al mismo precio que el publicado, los cargos pueden ser más elevados". — [Academia Nubimetrics: Cambios en Mercado Libre 2025](https://academia.nubimetrics.com/cambios-mercado-libre) (no se pudo leer la página completa)
- Quién absorbe el costo: según una guía de Mercado Pago UY de 2026, las cuotas sin interés las puede pagar **el banco emisor** (promociones de tarjeta) o **el vendedor**, mediante una comisión que sube con la cantidad de cuotas. — [Tiendli: MercadoPago Uruguay guía 2026](https://tiendli.com/blog/mercadopago-uruguay-guia)
- Fuera del marketplace (checkout de Mercado Pago), si el vendedor configura cuotas sin interés con cualquier banco, **absorbe el costo de financiación**, que se descuenta al acreditarse el pago. El extracto es genérico de Mercado Pago, sin país claro. — [Resultados de búsqueda sobre cuotas con Mercado Pago, p.ej. iProUP](https://www.iproup.com/finanzas/31634-paso-a-paso-como-pagar-u-ofrecer-cuotas-en-mercado-pago)
- La comisión de cobro con OCA en Mercado Pago ronda el **5%**, según un blog uruguayo sin fecha clara. — [Seosur: Qué tarjetas acepta Mercado Pago Uruguay](https://seosur.com.uy/blog/que-tarjetas-acepta-mercado-pago-uruguay)
- Las tarjetas de bancos extranjeros no tienen opción de cuotas, según la página de pagos de una tienda uruguaya (no es MELI). — [Forus UY: Cómo pagar](https://www.forusuy.com/como-pagar)
- **Contraste MLA:** en Argentina, ofrecer cuotas sin interés cuesta **entre 7% y 22% del precio de venta**, según el plan y la categoría: **6 cuotas 12-15%, 9 cuotas 17-19%, 12 cuotas 20-22%**. — [Base.com blog AR: cuotas sin interés en Mercado Libre](https://base.com/es-AR/blog/?p=18443)
- **Contraste MLA:** en Argentina existen "campañas con cuotas" configurables vía API para el marketplace (developers MLA). En MLA la Clásica solo ofrece cuotas con interés bancario. — [developers.mercadolibre.com.ar: campaña con cuotas](https://developers.mercadolibre.com.ar/campana-con-cuotas-para-marketplace)

### Inferences
- En AR, la "multipublicación por cuotas" (misma ficha en Clásica sin cuotas a precio bajo, y Premium o campaña 3/6/12 cuotas a precio más alto) funciona porque el costo de financiar es enorme (12-22%) y el comprador argentino valora mucho las cuotas por la inflación. En UY el costo de financiar es mucho menor (unos 4% según Nubimetrics, frente a 2 pp de diferencia Clásica/Premium). Por eso la diferencia de precio entre la variante "contado" y la variante "en cuotas" debería ser **mucho más chica** en UY. Si se copian los saltos de precio de AR, la variante en cuotas queda cara y no compite.
- Uruguay tiene inflación baja y una economía parcialmente dolarizada (contexto general, sin cifras verificadas en esta investigación). Eso reduce el atractivo "financiero" de las cuotas, pero su uso como facilitador de compra sigue siendo visible: los listados muestran de forma destacada 10 y 12 cuotas, y emisoras de crédito al consumo como OCA y Creditel son protagonistas. Las cuotas probablemente pesan más en tickets altos (electrónica, electrodomésticos) que en tickets bajos.
- Como en MLU las cuotas parecen venir "empaquetadas" con Premium (12 cuotas), la palanca de cuotas en UY probablemente se reduce a **Clásica contra Premium**, sin la granularidad 3/6/9/12 de las campañas argentinas. Esto no se pudo confirmar.

### Gaps
- No se encontró documentación oficial de MLU sobre el costo exacto de las 12 cuotas sin interés de Premium, ni sobre si hay "campañas de cuotas" o planes elegibles por publicación en UY. developers.mercadolibre.com.uy no devolvió una página propia sobre esto.
- No hay datos de 2025-2026 sobre qué porcentaje de compras en MLU se hace en cuotas, ni comparación de ese dato con AR.
- No se pudo verificar la tabla vigente de cuotas por emisora (Creditel 14, etc.). Puede haber cambiado.

---

## 3. Envío gratis y Mercado Envíos en Uruguay: umbral, quién paga, modalidades (Flex, Colecta, Full, agencias) y tiempos al interior

### Takeaway
El umbral oficial más reciente que se encontró es de 2021 (**más de $U 2.000** en artículos nuevos con Mercado Envíos). Fuentes no oficiales de 2026 hablan de unos $U 1.200, así que el umbral vigente **no está confirmado**. **Flex existe en UY, solo para Montevideo y Canelones.** Colecta también existe. La presencia de **Full con depósito propio en Uruguay es dudosa**: según Forbes Uruguay (septiembre de 2026), el centro de Canelones **no almacena, consolida**. Al mismo tiempo, el Centro de Vendedores de MLU tiene una página sobre "Cargos de Full" y algunos listados muestran la etiqueta "Enviado por FULL". No hay datos sobre DAC, agencias ni tiempos de entrega al interior.

### Cited Findings
- Comunicado oficial de MLU (antiguo, alrededor de 2021): envío gratis en compras de **artículos nuevos de más de $2.000** disponibles por Mercado Envíos. — [Mercado Libre UY, Noticias: envíos gratis](https://www.mercadolibre.com.uy/institucional/comunicamos/noticias/mercado-libre-envios-gratis); [Montevideo Portal: envíos gratis en compras mayores a $2000](https://www.montevideo.com.uy/Negocios-y-Tendencias/A-partir-de-ahora-Mercado-Libre-ofrece-envios-gratis-en-compras-mayores-a-2000-uc793302?plantilla=1385)
- Un sitio de cupones de 2026 (no oficial) dice que hay envío gratis en muchos productos nuevos **de más de $1.200 (UYU)**, según las condiciones del vendedor y la ubicación. Otra página de ofertas menciona "desde $500". — [Cupones Uruguay: Mercado Libre Uruguay](https://www.cuponesuruguay.com.uy/tienda/mercado-libre-uruguay/)
- La home de MLU se titula "Mercado Libre Uruguay - Envíos Gratis en el día". — [mercadolibre.com.uy](https://www.mercadolibre.com.uy/)
- En general, el "envío gratis" lo absorbe **el vendedor, total o parcialmente**; el comprador no paga la logística (guía genérica, no específica de UY). — [UpSeller: qué es el envío gratis en Mercado Libre](https://www.upseller.com/es/blog-article-444)
- **Flex en UY:** la documentación oficial de developers lista a Uruguay entre los países con Envíos Flex, con **cobertura en Montevideo y Canelones**. La ficha de la app Envíos Flex en Google Play dice que el servicio solo está disponible para vendedores de Montevideo y Canelones. Flex es un servicio en el que el vendedor hace los envíos por su cuenta, los 7 días de la semana. — [developers.mercadolibre.com.mx: Envíos Flex](https://developers.mercadolibre.com.mx/envios-flex); [developers.mercadolibre.com.ar: Envíos Flex](https://developers.mercadolibre.com.ar/es_ar/envios-flex); [Google Play: Envíos Flex (UY)](https://play.google.com/store/apps/details?id=com.mercadoenvios.driver&gl=uy); [Marco Postal: Envíos Flex en Uruguay](https://marcopostal.com.uy/envios-flex-mercado-libre/)
- **Colecta en UY:** según una guía de un proveedor local, Mercado Libre retira el paquete en el domicilio o negocio del vendedor, y el volumen mínimo suele ser de **3 a 5 envíos por día**. La misma guía describe Flex como entrega en un centro de distribución de MLU con retiro del comprador en un punto cercano, lo que **contradice** la documentación oficial de Flex. Hay que tomarla con cautela. — [Meli Track 10: Guía de Mercado Envíos en MLU](https://melitrack10.com/blog/guia-mercado-envios)
- La página institucional de Mercado Envíos de MLU dice que el sistema se adapta a cada país: a veces los operadores retiran en el domicilio del vendedor o en puntos postales y entregan directo (drop shipping), y otras veces el paquete pasa por centros de almacenamiento o de cross docking. — [Mercado Libre UY: Qué es Mercado Envíos](https://www.mercadolibre.com.uy/institucional/hacemos/que-es-mercado-envios)
- El Centro de Vendedores de MLU describe un **"Reporte de Full" / "Cargos de Full"** con cargos de almacenamiento, logística y penalidades. Dice que para usar Full el vendedor tiene que enviar sus productos a un centro de almacenamiento. Puede ser contenido regional replicado en todos los sitios. — [Central de aprendizaje MLU: qué reportes puedo conciliar](https://vendedores.mercadolibre.com.uy/nota/que-reportes-puedo-conciliar)
- **Contradicción sobre Full en UY:** Forbes Uruguay (septiembre de 2026, sobre la inversión de US$12,8M) dice que el centro de Canelones **"no almacena productos sino que los consolida"** para distribuirlos a todo el país. — [Forbes Uruguay: MELI invierte US$12,8M](https://www.forbesuruguay.com/negocios/mercado-libre-invierte-us-128m-oficinas-logistica-tenemos-entregar-mas-mas-rapido-todo-todo-uruguay-dijo-gamba-n96934). Un artículo de UpSeller lista Full como operativo en México, Argentina, Chile y Colombia, **sin Uruguay**. — [UpSeller blog](https://upseller.com/es/blog-article-777). En cambio, un resumen de búsqueda de listados de MLU menciona la etiqueta **"Enviado por FULL"** en algunos productos (no verificado, quizá cross-border o un error del resumen). — [Listado MLU: rosa](https://listado.mercadolibre.com.uy/rosa); [Listado MLU: asiento para bicicleta](https://listado.mercadolibre.com.uy/asiento-para-bicicleta)
- Infraestructura (septiembre de 2026): **US$4M para triplicar el centro de última milla de Canelones, de 4.000 a 12.000 m²**, dentro de una inversión total de US$12,8M (US$8,8M en oficinas en Montevideo). El country manager Diego Gamba dijo: "Tenemos que entregar más, más rápido y en todo el Uruguay". La dotación en el pico de operación pasaría de 113 a 220 personas. — [Forbes Uruguay](https://www.forbesuruguay.com/negocios/mercado-libre-invierte-us-128m-oficinas-logistica-tenemos-entregar-mas-mas-rapido-todo-todo-uruguay-dijo-gamba-n96934); [Montevideo Portal](https://www.montevideo.com.uy/Negocios-y-Tendencias/Mercado-Libre-invertira-US-12-8-millones-para-ampliar-sus-operaciones-en-Uruguay-uc974001); [Comercio y Justicia](https://comercioyjusticia.info/negocios/mercado-libre-amplia-su-operacion-logistica-en-uruguay/); [La Nación (02-09-2026)](https://www.lanacion.com.ar/economia/negocios/mercado-libre-invierte-us128-millones-en-uruguay-y-amplia-su-capacidad-logistica-nid02092026/)
- Un brand studio de El Observador habla de "16 envíos por minuto" de MELI en Uruguay. Solo se vio el título. — [El Observador (brand studio)](https://www.elobservador.com.uy/brand-studio/16-envios-minuto-y-un-ecosistema-que-revoluciona-el-e-commerce-uruguay-los-secretos-del-liderazgo-mercado-libre-n6021115)
- Una fuente genérica dice que Mercado Libre permite activar Full y Flex en la misma publicación (contexto AR/regional). — [UpSeller: publicación con Envíos Flex y Full](https://www.upseller.com/es/blog-article-156)

### Inferences
- **La palanca "Full contra no Full" de AR probablemente no se puede usar en UY,** o tiene un alcance muy limitado, porque el centro de Canelones es de consolidación y no de almacenamiento. En UY la diferenciación logística que se puede hacer de forma realista es **Flex (entrega en el día en Montevideo/Canelones) contra Colecta (Mercado Envíos estándar)**. Antes de diseñar una variante "Full" hay que confirmarlo en la cuenta.
- Flex solo cubre Montevideo y Canelones. Una variante Flex en UY le habla al área metropolitana, que probablemente concentra buena parte de la demanda, aunque no hay cifras.
- El umbral de envío gratis en UY (entre $U 1.200 y $U 2.000, unos US$ 30-50) está muy por debajo en dólares del de AR (ARS 28.000-30.000 según resultados de búsqueda argentinos, no verificados aquí). Muchos más productos de UY quedan dentro del envío gratis obligatorio, así que "envío gratis sí/no" es una palanca de multipublicación más débil en UY. Esto depende de confirmar el umbral vigente.

### Gaps
- No se encontró el umbral oficial de envío gratis de MLU para 2025-2026, ni la tabla de costos de envío o los subsidios para el vendedor.
- No se encontró información oficial sobre Full en Uruguay (si existe, requisitos, tarifas, fecha de lanzamiento), ni sobre Mercado Libre Places, retiro en agencia, DAC u otros correos como transportistas de Mercado Envíos.
- No hay datos de tiempos de entrega al interior del país (fuera de Montevideo y Canelones).

---

## 4. Filtros de búsqueda en mercadolibre.com.uy

### Takeaway
Según extractos de páginas de listado de MLU, el panel de filtros tiene **"Costo de envío: Gratis"**, **"Envío: Mercado Envíos"** y, en "Detalles de la publicación", **"En cuotas"**. No se encontró un filtro "Full", a diferencia de MLA, donde existe. Las tarjetas de producto muestran juntas las cuotas sin interés y el envío gratis.

### Cited Findings
- Los filtros de envío que se ven en listados de MLU son **"Costo de envío (Gratis)"** y **"Envío (Mercado Envíos)"**. El filtro de detalles de la publicación ofrece **"En cuotas"**. No se encontró un filtro "Full" en los paneles que se vieron. — [Listado MLU: sillas de auto](https://listado.mercadolibre.com.uy/bebes/paseo-bebe/sillas-autos/); [Listado MLU: rosa](https://listado.mercadolibre.com.uy/rosa)
- Las tarjetas de producto en MLU muestran "10 cuotas de $827,90 sin interés" junto a "Envío gratis". — [Listado MLU: sillas de auto](https://listado.mercadolibre.com.uy/bebes/paseo-bebe/sillas-autos/)

### Inferences
- Si el filtro de MLU es "En cuotas" y no "Cuotas sin interés", puede que la variante Premium con 12 cuotas no tenga un filtro específico que la favorezca. Aun así gana exposición "Máxima" en el ranking, según la ayuda 870.
- Sin filtro Full, la logística diferencial no tiene un filtro de búsqueda que la empuje en UY. Pesan más el envío gratis y la promesa de entrega ("llega hoy/mañana").

### Gaps
- No se pudo abrir en vivo una página de listado de MLU para enumerar todos los filtros (p.ej. "Llega hoy", "Tiendas oficiales", "Mejores vendedores", descuentos). Los datos salen de extractos parciales.

---

## 5. Catálogo y buy box en Uruguay

### Takeaway
El catálogo y la competencia por el "primer lugar" (buy box) **están activos en MLU**: el Centro de Vendedores uruguayo tiene notas propias sobre el tema. La documentación de developers sobre "publicaciones requeridas en catálogo" (de alcance probablemente regional) dice que en los dominios con catálogo obligatorio la publicación tradicional que no se asocia puede quedar moderada o inactiva. No se encontró la lista de categorías con catálogo en UY.

### Cited Findings
- El Centro de Vendedores de MLU tiene la nota "Para qué sirven las publicaciones de catálogo", con el mensaje "con catálogo el primer lugar del listado puede ser tuyo" (competencia por el buy box). — [Centro de Vendedores MLU: publicaciones de catálogo](https://vendedores.mercadolibre.com.uy/nota/con-catalogo-el-primer-lugar-del-listado-puede-ser-tuyo/?suScope=prod)
- MLU permite publicar a partir de productos que ya están a la venta (opt-in a una ficha de catálogo existente). — [Centro de Vendedores MLU: publica a partir de productos que ya están a la venta](https://vendedores.mercadolibre.com.uy/nota/publica-a-partir-de-productos-que-ya-estan-a-la-venta)
- Según la documentación de developers en el dominio .com.uy, a veces la publicación original queda inactiva al pasar a catálogo y otras veces se puede seguir vendiendo con ambas. En los dominios con catálogo obligatorio, la publicación tradicional que no se asocia a un producto de catálogo puede ser moderada o inactivada. El extracto afirma que "la mayoría de dominios son de publicación obligatoria en catálogo", aunque el contenido puede ser de MLA replicado. — [developers.mercadolibre.com.uy: publicaciones requeridas en catálogo](https://developers.mercadolibre.com.uy/es_ar/publicaciones-requeridas-en-catalogo); [developers.mercadolibre.com.uy: publicar productos](https://developers.mercadolibre.com.uy/es_ar/publica-productos)

### Inferences
- En AR, la multipublicación suele combinar una publicación de catálogo, que compite por el buy box, con varias tradicionales, cada una con una oferta distinta. Ese esquema parece trasladable a UY. Con menos vendedores por producto (ver sección 6), ganar el buy box en UY podría ser más fácil, y una publicación de catálogo bien ubicada podría quitarle tráfico a las tradicionales del mismo vendedor.

### Gaps
- No se encontró la lista de dominios o categorías con catálogo obligatorio en MLU, ni datos de penetración del catálogo en UY frente a AR.

---

## 6. Tamaño de mercado, competencia y moneda (USD contra UYU)

### Takeaway
MLU tiene **unos 160.000 vendedores**, **más de 8 millones de artículos publicados** y **unos 1,2 millones de compradores por año**, con datos de 2025-2026. Es un mercado de un orden de magnitud menor que AR, así que hay menos competidores por palabra clave y la demanda se satura antes. No se encontró una fuente oficial sobre si se puede publicar en USD. Por convención local, "U$S" indica dólares y "$" pesos, y algunos rubros como los inmuebles se publican en dólares. El tipo de cambio ronda los 40,6 UYU/USD.

### Cited Findings
- MLU tiene **más de 160.000 vendedores** y **más de 8 millones de artículos publicados** (septiembre de 2026). — [Forbes Uruguay](https://www.forbesuruguay.com/negocios/mercado-libre-invierte-us-128m-oficinas-logistica-tenemos-entregar-mas-mas-rapido-todo-todo-uruguay-dijo-gamba-n96934); [EGU](https://www.egu.org.uy/post/mercado-libre-invierte-us-12-8-millones-en-uruguay-inaugur%C3%B3-sus-oficinas-en-cosmos-y-triplicar%C3%A1-1)
- **1,2 millones de uruguayos compran por año** en Mercado Libre (Montevideo Portal, reciente). Unos dos años antes, el country manager hablaba de **900.000 compradores únicos por año**. — [Montevideo Portal: cómo ve a Uruguay MELI](https://www.montevideo.com.uy/Negocios-y-Tendencias/Mercado-Libre-como-ve-a-Uruguay-una-empresa-que-opera-en-toda-America-Latina-uc979241); [Forbes Uruguay: "El tamaño de la torta es muy grande" (efecto Temu)](https://www.forbesuruguay.com/innovacion/el-tamano-torta-muy-grande-dijo-country-manager-mercado-libre-uruguay-efecto-temu-adelanto-exploran-envios-cross-border-n80019)
- La meta declarada de MELI en UY era "un millón de compradores", según el título de una nota de Infonegocios. — [Infonegocios: "Yo quiero tener un millón de compradores"](https://infonegocios.biz/nota-principal/yo-quiero-tener-un-millon-de-compradores-el-plan-de-mercado-libre-para-uruguay)
- Unas **10.000 pymes** trabajan con el sistema (Ámbito, hace unos 13 meses, alrededor de octubre de 2025). — [Ámbito: Uruguay es un oasis](https://www.ambito.com/uruguay/mercado-libre-se-expande-el-pais-y-sus-ejecutivos-valoran-el-clima-negocios-es-un-oasis-n6202990)
- En 2026, más de 100.000 comercios cobraron con Mercado Pago en UY, y el 90% son pymes o micropymes. — [EGU](https://www.egu.org.uy/post/mercado-libre-invierte-us-12-8-millones-en-uruguay-inaugur%C3%B3-sus-oficinas-en-cosmos-y-triplicar%C3%A1-1)
- MELI emplea a unas **1.800 personas** en Uruguay. — [iProUP: Mercado Libre crece en Uruguay](https://www.iproup.com/finanzas/71232-mercado-libre-crece-en-uruguay-y-acelera-la-inversion-en-argentina); [Descubre.vc (02-09-2026)](https://www.descubre.vc/noticia/mercado-libre-invierte-us-12-8-millones-para-potenciar-su-log-stica-en-uruguay-2026-09-02)
- El country manager reconoce la competencia de Temu y dice que MELI explora envíos cross-border en UY. — [Forbes Uruguay (efecto Temu)](https://www.forbesuruguay.com/innovacion/el-tamano-torta-muy-grande-dijo-country-manager-mercado-libre-uruguay-efecto-temu-adelanto-exploran-envios-cross-border-n80019)
- **Moneda:** en Uruguay, "U$S" en una publicación significa dólares y "$" suele significar pesos, y los inmuebles se publican normalmente en dólares (foro Expat, anecdótico). En un hilo antiguo del grupo de developers de Mercado Pago se dice que el sitio de MELI permite pagos en dólares, mientras que una integración solo procesaba pesos. — [Expat.com foro Montevideo](https://www.expat.com/es/forum/america-del-sur/uruguay/montevideo/576488-que-moneda-refleja-la-pagina-de-mercadolibre.html); [Google Groups mercadopago-developers](https://groups.google.com/g/mercadopago-developers/c/jR5gIkjthKo)
- Tipo de cambio de referencia: **unos 40,6 UYU por USD** (BROU, consultado en noviembre de 2026). — [Datos Uruguay: Dólar hoy](https://datosuruguay.com/dolar)

### Inferences
- Con unos 160.000 vendedores y 1,2 millones de compradores al año, cada palabra clave de MLU tiene mucho menos volumen de búsqueda y menos competidores que en MLA. Un set de 4 a 6 publicaciones del mismo producto, habitual en AR, puede **canibalizarse** en UY: las variantes compiten entre sí por el mismo tráfico reducido. Lo prudente sería arrancar con **2 o 3 variantes** bien diferenciadas, por ejemplo Clásica a precio bajo, Premium con 12 cuotas y un kit, y medir antes de agregar más.
- Con menos competencia, una sola publicación bien posicionada puede ocupar varias posiciones de la primera página. El beneficio marginal de "ocupar más espacio" con multipublicaciones probablemente se agota antes que en AR.
- Si se publica en USD, el precio en pesos que ve el comprador fluctúa con el tipo de cambio. Eso puede romper sin querer la escalera de precios entre variantes (p.ej. una variante en USD y otra en UYU). Conviene que todas las variantes de un mismo producto usen la misma moneda. Esto es una inferencia, no una regla documentada.
- En AR la inflación obliga a reprecios frecuentes, y cada variante de multipublicación multiplica ese trabajo. En UY la menor inflación reduce el costo operativo de mantener varias publicaciones.

### Gaps
- No se encontró una fuente oficial de MLU sobre en qué categorías se permite publicar en USD, ni sobre cómo se calculan en ese caso los umbrales en pesos (costo fijo de $400, envío gratis).
- No hay datos de la Cámara de la Economía Digital del Uruguay (CEDU) de 2025-2026 en los resultados, ni métricas de competencia por categoría en MLU (vendedores por producto, concentración).
- No hay cifras comparables y verificadas de MLA (vendedores y compradores) en esta investigación.

---

## 7. Política de publicaciones duplicadas en Uruguay

### Takeaway
La política vigente del Centro de Vendedores de MLU define como duplicadas las publicaciones del **mismo producto con las mismas condiciones de venta**. Sugiere explícitamente diferenciarlas **cambiando precio, tipo de publicación o método de envío**, que son justamente las palancas de la multipublicación. Si detecta duplicadas, la plataforma oculta las de menor visibilidad y deja activa la mejor. Una política uruguaya muy antigua fijaba un tope de 2 anuncios idénticos, que no debe tomarse como vigente.

### Cited Findings
- Las publicaciones duplicadas son anuncios del mismo producto con las mismas condiciones de venta. **No están permitidas y se dan de baja automáticamente.** Si el vendedor ya tiene duplicadas, la plataforma **oculta las de menor visibilidad y deja activa la de mejor exposición**. Para evitarlas, recomienda usar variantes dentro de una sola publicación (colores, talles) o diferenciar títulos y fotos. **Para crear una publicación similar a una existente, sugiere cambiar el precio, el tipo de publicación o el método de envío.** — [Centro de Vendedores MLU: Publicaciones duplicadas, qué son y cómo evitarlas](https://vendedores.mercadolibre.com.uy/nota/publicaciones-duplicadas-que-son-y-como-evitarlas)
- La página de Políticas de Publicación de MLU es muy antigua (más de unos 5.000 días) y mencionaba un **tope de 2 anuncios para artículos idénticos** publicados de forma individual. No conviene tomarla como vigente. — [Mercado Libre UY: Políticas de Publicación (antigua)](https://www.mercadolibre.com.uy/seguro_publicacion.html)
- La documentación de developers (de más de unos 1.300 días) indica que los anuncios considerados duplicados quedan en estado "under review". — [developers.mercadolibre.com.uy: publicar productos](https://developers.mercadolibre.com.uy/es_ar/publica-productos)

### Inferences
- La regla uruguaya parece la misma que la de MLA: lo que se prohíbe es duplicar **condiciones**, no el producto. Por eso el playbook argentino se puede trasladar siempre que cada variante cambie de verdad al menos precio, tipo de publicación (Clásica/Premium), envío (Flex, Colecta, gratis o no) o la composición del kit.
- El mecanismo de "ocultar las de menor visibilidad" implica que dos variantes demasiado parecidas no dan error: una de las dos queda invisible sin aviso. En un mercado chico como UY conviene monitorear las impresiones por publicación.

### Gaps
- No se encontró una versión 2025-2026 de las Políticas de Publicación de MLU con un tope numérico de publicaciones por producto, ni diferencias formales con MLA.

---

## 8. Experiencias de vendedores uruguayos y consultores sobre multipublicación en UY

### Takeaway
No se encontró contenido específico (posts, videos o consultores uruguayos) sobre multipublicación en MLU. Lo que hay son guías genéricas de terceros sobre Mercado Envíos y costos en UY, y notas de prensa corporativas.

### Cited Findings
- Algunos proveedores de software o servicios publican guías generales para vendedores de MLU (logística, costos y Mercado Pago), sin tratar la multipublicación. — [Meli Track 10: Guía de Mercado Envíos en MLU](https://melitrack10.com/blog/guia-mercado-envios); [WooSync: Mercado Envíos en Uruguay 2026](https://www.woosync.io/blog/mercado-envios-desembarca-en-uruguay/); [Tiendli: MercadoPago Uruguay 2026](https://tiendli.com/blog/mercadopago-uruguay-guia); [Tiendli: Cómo vender en Mercado Libre 2026](https://tiendli.com/blog/como-vender-en-mercadolibre/)
- MELI organiza en Uruguay el evento para vendedores "Mercado Libre Experience". — [Mercado Libre Experience UY](https://www.mercadolibreexperience.com.uy/edicion-2024/)

### Inferences
- La falta de contenido local sugiere que la multipublicación como táctica explícita está menos difundida en UY que en AR. Eso podría ser una ventaja para quien la aplique primero, aunque también puede reflejar que el tamaño del mercado limita su rendimiento.

### Gaps
- No se encontraron testimonios, videos de YouTube ni posts de vendedores o consultores uruguayos sobre multipublicación, saturación por palabra clave o diferencias de algoritmo frente a AR. Habría que buscar en YouTube, grupos de Facebook o Instagram de vendedores uruguayos, que no son accesibles en esta sesión.

---

## 9. Impuestos y facturación que afectan el precio (IVA, Literal E, DGI)

### Takeaway
MELI UY aplica retenciones según la condición fiscal registrada (Decreto 94/002), pero **no las aplica a los contribuyentes Literal E** ni a quienes tienen exclusión. Los Literal E pagan IVA mínimo y desde 2025 deben emitir comprobantes fiscales electrónicos (CFE). Esto difiere del esquema argentino (monotributo, retenciones de IVA y Ganancias), así que los cálculos de margen de AR no se pueden copiar.

### Cited Findings
- MLU calcula las alícuotas de retención según la condición fiscal registrada en Mercado Libre o Mercado Pago, y **no aplica la retención del Decreto 94/002 a quienes tienen exclusión de retenciones o son Literal E**. — [Centro de Vendedores MLU: Cuándo y cómo se aplican impuestos a mis ventas](https://vendedores.mercadolibre.com.uy/nota/cuando-y-como-se-aplican-impuestos-a-mis-ventas)
- El Literal E paga a la DGI un **IVA mínimo**, un porcentaje chico de la facturación (se citan valores del **2% al 3,3%**). La DGI puede excluir a un contribuyente del Literal E de forma retroactiva y cobrarle IRAE con multas. La atribución exacta entre estas dos fuentes es aproximada. — [Ahorrin: Literal E Uruguay](https://www.ahorrin.app/blog/literal-e-uruguay-que-es-limites-conviene); [Castillo.uy: Facturación electrónica Literal E 2026](https://castillo.uy/blog/facturacion-electronica-literal-e-2026/)
- Desde el **1 de enero de 2025**, todos los contribuyentes de IVA, incluidos los de IVA mínimo (Literal E), deben emitir **Comprobantes Fiscales Electrónicos (CFE)**. — [Castillo.uy: Facturación electrónica Literal E 2026](https://castillo.uy/blog/facturacion-electronica-literal-e-2026/); [Memory.com.uy: Facturación electrónica Literal E](https://memory.com.uy/blog/obligaciones-fiscales/facturacion-electronica-literal-e/)
- Hay fuentes contradictorias sobre si el Literal E emite facturas "con IVA" o no. — [Memory.com.uy](https://memory.com.uy/blog/obligaciones-fiscales/facturacion-electronica-literal-e/); contradicho por [Ahorrin](https://www.ahorrin.app/blog/literal-e-uruguay-que-es-limites-conviene)

### Inferences
- Un vendedor Literal E en UY tiene una carga fiscal sobre la venta baja y predecible: IVA mínimo y sin retención de MELI. Eso le da más margen para que las variantes de precio bajo (Clásica, sin cuotas) sean agresivas, comparado con un vendedor uruguayo en régimen general de IVA, que debe sumar el IVA a cada escalón de precio.
- Las retenciones argentinas sobre ventas en MELI y el monotributo no aplican en UY. Las calculadoras de precio del playbook argentino tienen que rehacerse con la estructura fiscal uruguaya.

### Gaps
- No se confirmó la tasa básica de IVA en UY (22%) ni si la comisión de MELI UY se factura con IVA. Tampoco el tope de facturación vigente del Literal E para 2026, ni las alícuotas concretas de retención del Decreto 94/002 que aplica MLU a contribuyentes del régimen general.
