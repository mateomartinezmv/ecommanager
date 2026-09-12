-- Agrega la columna numero_pi a importaciones y la completa por defecto
-- extrayendo el número de PI (ej: "PI10196") que ya vivía dentro de "notas".
ALTER TABLE importaciones ADD COLUMN IF NOT EXISTS numero_pi TEXT;

UPDATE importaciones
SET numero_pi = upper(regexp_replace((regexp_match(notas, 'PI[-\s]*\d+', 'i'))[1], '[-\s]', '', 'g'))
WHERE numero_pi IS NULL
  AND notas IS NOT NULL
  AND notas ~* 'PI[-\s]*\d+';
