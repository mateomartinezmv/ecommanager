-- Telegram más ordenado.
--
-- telegram_preguntas: una fila por pregunta de MELI avisada al bot, con la respuesta
-- sugerida que publican los botones ✅ Aceptar / ❌ Rechazar (ver api/_telegramPreguntas.js).
-- La clave primaria es lo que evita los avisos repetidos: MELI manda el mismo aviso varias
-- veces y sólo el primero logra insertar.
--
-- stock_sync_fallos: las publicaciones a las que el cron de stock no les pudo corregir el
-- número, con cuántas corridas seguidas van fallando. Avisa recién a la tercera y una sola
-- vez (ver api/_fallosStock.js).
--
-- Las dos se usan sólo desde la API con la service key: RLS activado y sin políticas, igual
-- que el resto de las tablas internas.

CREATE TABLE IF NOT EXISTS telegram_preguntas (
  question_id  TEXT PRIMARY KEY,
  item_id      TEXT,
  item_titulo  TEXT,
  pregunta     TEXT,
  respuesta    TEXT,
  -- Lo que dijo el CRM sobre la disponibilidad al redactar (la línea "📊 Stock CRM").
  stock_crm    TEXT,
  estado       TEXT NOT NULL DEFAULT 'avisando'
               CHECK (estado IN ('avisando', 'pendiente', 'sin_borrador', 'publicando',
                                 'publicada', 'rechazada', 'respondida_fuera', 'ignorada')),
  message_id   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_sync_fallos (
  meli_id     TEXT PRIMARY KEY,
  sku         TEXT,
  titulo      TEXT,
  error       TEXT,
  veces       INTEGER NOT NULL DEFAULT 1,
  avisado     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE telegram_preguntas ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_sync_fallos ENABLE ROW LEVEL SECURITY;

-- Para la base donde la tabla ya se había creado sin la columna.
ALTER TABLE telegram_preguntas ADD COLUMN IF NOT EXISTS stock_crm TEXT;
