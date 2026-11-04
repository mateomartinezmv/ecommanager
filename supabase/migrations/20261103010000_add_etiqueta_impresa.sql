-- Etiquetas del CRM (mostrador y Shopify) impresas desde ✅ Control de despacho → 🖨️.
--
-- Las de MELI no hace falta anotarlas: MELI dice si ya se imprimieron (desde el CRM o desde
-- su panel). Las del CRM, en cambio, las arma el propio CRM y nadie más lo sabe, así que para
-- que "Las que faltan imprimir" las deje afuera después de recargar la página se anota acá.
-- Sin esta columna funciona igual, pero sólo lo recuerda mientras la página siga abierta.

alter table envios add column if not exists etiqueta_impresa_at timestamptz;

comment on column envios.etiqueta_impresa_at is
  'Cuándo se imprimió la etiqueta del CRM (100 × 150) desde Control de despacho. Las de MELI no se anotan: lo dice MELI.';
