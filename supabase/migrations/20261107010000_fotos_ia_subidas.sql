-- Fotos propias en Marketing → 📸 Fotos: además de generarlas con la API de Higgsfield, se
-- pueden subir imágenes hechas afuera (por ejemplo con los créditos de la app de Higgsfield)
-- para que el CRM las publique en la original y en todos los ángulos de la variante.
--
-- Una foto subida es una fila de fotos_ia con tipo 'subida', que nace ya 'lista' (no pasa por
-- Higgsfield) y con su `orden`: el lugar en que el vendedor la quiere en la publicación. Las
-- generadas siguen ordenándose por tipo (portada, medidas, …) y no usan `orden`.

ALTER TABLE fotos_ia ADD COLUMN IF NOT EXISTS orden INTEGER;

ALTER TABLE fotos_ia DROP CONSTRAINT IF EXISTS fotos_ia_tipo_check;
ALTER TABLE fotos_ia ADD CONSTRAINT fotos_ia_tipo_check
  CHECK (tipo IN ('portada', 'medidas', 'compatible', 'beneficios', 'instalacion', 'subida'));

COMMENT ON COLUMN fotos_ia.orden IS
  'Sólo en las fotos subidas (tipo subida): posición en la publicación, empezando en 0.';
