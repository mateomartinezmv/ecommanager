-- Carga inicial de productos.codigo_gesta (4/11/2026), a partir de la lista de productos de
-- app.gesta.uy/products (Gesta no exporta productos: se copió de la pantalla) emparejada por
-- nombre y precio, y revisada a mano.
--
-- Quedan sin código a propósito: los extensores de espejo (EXT-ESP-*) y los manillares altos
-- MAN-78-V2-NEG-001 / MAN-78-V2-PLA-001, que no están en Gesta. En Gesta sobran el 2 (Baby
-- Alive, no es un producto del CRM), el 25 (Parabrisas Pollerita) y el 31 (Protector de correa
-- duplicado: se usa el 30).
--
-- Correr después de supabase/migrations/20261104010000_add_codigo_gesta.sql.

UPDATE productos AS p SET codigo_gesta = m.codigo
FROM (VALUES
  ('HP-MG072', 1), ('DFB-002', 3), ('HP-EXHAUST-GBLACK', 4), ('HP-EXHAUST-GSILVER', 5),
  ('HP-EXHAUST-A', 6), ('2004-107', 7), ('HP-SH-5003-L', 8), ('ALERONFINOSNK', 9),
  ('HSJ-20121', 10), ('YTLY-30', 11), ('GZTYJ-41046N', 12), ('GZTYJ-41046R', 13),
  ('HP-DB004-B', 14), ('HP-HS010', 15), ('HP-Q0212', 16), ('HP-Q0211', 17), ('HP-Q0213', 18),
  ('HP-CB0383', 19), ('HP-CB0384', 20), ('HP-CB0382', 21), ('HP-CB0381', 22), ('HP-CB0385', 23),
  ('SBJ-10078', 24), ('PATENTE1', 26), ('CPJ-62001', 27), ('HP-ZJ039', 28), ('POSAPIE1', 29),
  ('MELI-MLU1039263040', 30), ('HP-Q035B2', 32), ('HP-Q035B1', 33), ('HP-Q035B3', 34),
  ('DOM02', 35), ('DOM03', 36), ('DOM00', 37), ('DOM01', 38), ('PUNORGANG', 39),
  ('PUNBLACK', 40), ('PUNRED', 41), ('HP-Z0533', 42), ('SEÑAL01', 43), ('FSB-002', 44),
  ('FSB-003', 45), ('AP-TAILBOXLED', 46), ('AP-TAILBOXSQ', 47), ('HP-DF028', 48),
  ('AP-SLANTED01', 49), ('SOP-CEL-ESP-001', 50), ('ESP-CIR-001', 51), ('SOP-CEL-MAN-001', 52),
  ('HS-30006', 53), ('MAN-78-V3-NEG-001', 54), ('DOM04', 55), ('PUNYELLOW', 56)
) AS m(sku, codigo)
WHERE p.sku = m.sku;
