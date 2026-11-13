-- ¿El producto se publica con envío gratis en MELI?
--
-- Lo usa Promos MELI para el piso neto: con envío gratis el vendedor paga el envío (≈$159
-- promedio) y eso define cuánto descuento aguanta. Los productos baratos (soportes de
-- celular, puños Domino, pata de cabra) se publican sin envío gratis: lo paga el comprador.
--
-- Por defecto true: es lo que el negocio pone en casi todo. Se cambia desde Promos MELI.

ALTER TABLE productos ADD COLUMN IF NOT EXISTS envio_gratis boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN productos.envio_gratis IS
  'Si la publicación en MELI lleva envío gratis (lo paga el vendedor). Promos MELI lo usa para calcular el neto.';
