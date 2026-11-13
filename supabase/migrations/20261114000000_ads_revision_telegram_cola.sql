-- Revisión semanal de MELI Ads y promos.
--
-- ads_revision_partes: lo que junta el cron api/cron/ads-semanal.js cada lunes, una fila por
-- parte (campanas, anuncios, recomendaciones, promos, cambios) de la semana cerrada que
-- arranca en `semana` (lunes). Son las mismas cuentas que muestra la pestaña de Ads y la de
-- Promos, guardadas para que la tarea programada de Claude las analice sin hablar con MELI.
-- La tarea agrega su propia fila con parte = 'informe', que la de la semana siguiente lee
-- para ver qué se aplicó de lo recomendado.
--
-- telegram_cola: mensajes para el chat del dueño que escribe algo que no tiene el token del
-- bot (la tarea programada). El cron api/cron/telegram-cola.js los manda cada 5 minutos.
--
-- Las dos se usan sólo con la service key: RLS activado y sin políticas.

CREATE TABLE IF NOT EXISTS ads_revision_partes (
  semana       DATE NOT NULL,
  parte        TEXT NOT NULL,
  ok           BOOLEAN NOT NULL DEFAULT TRUE,
  error        TEXT,
  datos        JSONB,
  generado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (semana, parte)
);

CREATE TABLE IF NOT EXISTS telegram_cola (
  id          BIGSERIAL PRIMARY KEY,
  texto       TEXT NOT NULL,
  origen      TEXT,
  estado      TEXT NOT NULL DEFAULT 'pendiente'
              CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'error')),
  intentos    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_cola_pendientes ON telegram_cola (id) WHERE estado = 'pendiente';

ALTER TABLE ads_revision_partes ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_cola ENABLE ROW LEVEL SECURITY;
