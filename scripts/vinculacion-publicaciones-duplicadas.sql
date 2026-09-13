-- Vinculación de las publicaciones MELI que no estaban asociadas a ningún SKU
-- — aplicada el 2026-09-13. Ya está aplicado: no re-ejecutar.
--
-- De 53 publicaciones activas había 15 sin vincular, así que sus ventas no se
-- registraban ni descontaban stock. Se vincularon las 7 que matchean título y
-- precio exactos contra un producto del CRM (AP-TAILBOXLED se hizo aparte, en
-- reconciliacion-AP-TAILBOXLED.sql).

with vinculos(sku, nuevo) as (values
  ('AP-SLANTED01',    'MLU1475283052'),  -- Escape SC Project Boca Inclinada 51mm Negro
  ('AP-YOSHIMURA01',  'MLU1475283030'),  -- Escape Yoshimura Fibra Carbono 51mm
  ('ESP-CIR-001',     'MLU700264539'),   -- Espejos de Puño Circulares 7/8 Negro
  ('SOP-CEL-ESP-001', 'MLU1503030820'),  -- Soporte Celular Espejo
  ('SOP-CEL-MAN-001', 'MLU700273387'),   -- Soporte Celular Manillar
  ('AP-TAILBOXSQ',    'MLU1475257680'),  -- Baúl Trasero 45L (2ª publicación)
  ('FSB-002',         'MLU1327538194')   -- Slider Aluminio Grande Negro (2ª publicación)
)
update productos p
   set meli_ids = p.meli_ids || v.nuevo, updated_at = now()
  from vinculos v
 where p.sku = v.sku and not (v.nuevo = any (p.meli_ids));

-- Las dos únicas ventas que habían entrado por esas publicaciones:
--   · 2000018315668560 (06/09, slider) ya existía pero con sku NULL.
--   · 2000018437649730 (13/09, escape) no estaba registrada; se dio de alta.
update ventas v
   set sku = p.sku, producto = p.nombre
  from productos p
 where p.sku = 'FSB-002'
   and v.id = 'V_MELI_2000018315668560_MLU1327538194';

-- Ninguna de las dos había descontado stock y las unidades ya salieron.
update productos
   set stock_dep = stock_dep - 1, stock_meli = stock_meli - 1,
       stock_shopify = stock_shopify - 1, updated_at = now()
 where sku in ('FSB-002','AP-SLANTED01');

-- La GoPro (MLU1017734718) queda deliberadamente SIN vincular: fue una venta
-- personal de un artículo usado, ajena a la empresa, hecha por la misma cuenta
-- de MELI. Sólo se deja la aclaración en la venta.
update ventas
   set notas = 'Venta personal de un articulo usado, ajena a la empresa. Se vendio por la misma cuenta de MELI. La publicacion MLU1017734718 queda deliberadamente sin vincular a ningun SKU del CRM.'
 where id = 'V_MELI_2000014708277324_MLU1017734718';

-- Quedan 7 publicaciones activas sin vincular, a propósito:
--   Personales / ajenas a la empresa (mismo criterio que la GoPro):
--     MLU1314531996  Set Cambiador Bebé
--     MLU690817651   Borcegos de cuero para mujer
--     MLU695246803   Championes adidas Superstar mujer
--     MLU699762377   Pantalón Moto Torque Revo Talle XL (1 unidad, a confirmar)
--   Sin equivalente claro en el CRM, a definir:
--     MLU1503031072  Manillar Custom Chopper — Negro
--     MLU1503031074  Manillar Custom Chopper — Plateado
--     MLU700264541   Manillar Café Racer 7/8 Negro (el CRM sólo tiene el plateado)
