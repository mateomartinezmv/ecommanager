-- Auditoría quincenal de publicaciones de MELI.
--
-- pubs_auditoria_partes: lo que junta el cron api/cron/pubs-auditoria.js los días 1 y 15, una
-- fila por parte (conversion, angulos, fotos, publicaciones, preguntas) del día en que corrió.
-- La tarea programada de Claude lo analiza y agrega su fila con parte = 'informe', que la de
-- la quincena siguiente lee para ver qué se cambió de lo propuesto.
--
-- Se usa sólo con la service key: RLS activado y sin políticas.

CREATE TABLE IF NOT EXISTS pubs_auditoria_partes (
  fecha        DATE NOT NULL,
  parte        TEXT NOT NULL,
  ok           BOOLEAN NOT NULL DEFAULT TRUE,
  error        TEXT,
  datos        JSONB,
  generado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fecha, parte)
);

ALTER TABLE pubs_auditoria_partes ENABLE ROW LEVEL SECURITY;
