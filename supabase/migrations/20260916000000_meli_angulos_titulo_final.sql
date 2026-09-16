-- Título publicado y producto de usuario de cada ángulo.
--
-- En el modelo de User Products el vendedor manda un nombre base (family_name) y el título
-- que ve el comprador lo arma MELI pegándole los atributos de la variante. Guardar sólo lo
-- que mandamos deja el historial mintiendo: lo que quedó publicado es otra cosa.
--
-- user_product_id sirve para detectar el caso que arruina la jugada: si la publicación nueva
-- cae en el mismo producto de usuario que la original, MELI las trata como la misma cosa
-- (mismo título, mismo stock) y no hay tal ángulo nuevo.
ALTER TABLE meli_angulos
  ADD COLUMN IF NOT EXISTS titulo_final    TEXT,
  ADD COLUMN IF NOT EXISTS user_product_id TEXT;

COMMENT ON COLUMN meli_angulos.titulo IS
  'Lo que se mandó a MELI: title en el modelo viejo, family_name (nombre base) en User Products.';
COMMENT ON COLUMN meli_angulos.titulo_final IS
  'El título que quedó publicado, tal cual lo devolvió MELI.';
COMMENT ON COLUMN meli_angulos.user_product_id IS
  'Producto de usuario de la publicación nueva. Si coincide con el de la original, comparten título y stock: no es un ángulo aparte.';
