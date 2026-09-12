-- Migration: agrupación de productos en dos niveles
-- Feature: Stock → Grupos y subgrupos
--
-- `categoria` era un texto libre que se usaba de forma inconsistente
-- ("Escape" y "Escapes", "Espejo" y "Espejos", y 26 productos en blanco).
-- Se reemplaza por dos columnas explícitas:
--   grupo    → familia mayor del producto (Manillares, Escapes, Puños, Espejos…)
--   subgrupo → variante dentro de la familia (Domino, SC Project, Akrapovic…)
--
-- `categoria` se deja en la tabla pero deja de escribirse. Una vez que el
-- deploy nuevo esté andando se puede borrar con:
--   ALTER TABLE productos DROP COLUMN categoria;

ALTER TABLE productos ADD COLUMN IF NOT EXISTS grupo    TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS subgrupo TEXT;

CREATE INDEX IF NOT EXISTS productos_grupo_idx    ON productos(grupo);
CREATE INDEX IF NOT EXISTS productos_subgrupo_idx ON productos(grupo, subgrupo);

-- Semilla: normaliza los valores que ya había en `categoria` y clasifica el
-- resto del catálogo por familia. A partir de acá se edita desde la pantalla
-- de Stock; esto es sólo el punto de partida.
UPDATE productos SET grupo = 'Manillares', subgrupo = 'Universal 7/8'
  WHERE sku IN ('HP-CB0381','HP-CB0382','HP-CB0383','HP-CB0384','HP-CB0385');
UPDATE productos SET grupo = 'Manillares', subgrupo = 'Alto'
  WHERE sku IN ('MAN-78-V2-NEG-001','MAN-78-V2-PLA-001');
UPDATE productos SET grupo = 'Manillares', subgrupo = 'Café Racer'
  WHERE sku IN ('MAN-78-V3-PLA-001');
UPDATE productos SET grupo = 'Manillares', subgrupo = 'Accesorios de manillar'
  WHERE sku IN ('HP-MG072');

UPDATE productos SET grupo = 'Puños', subgrupo = 'Domino'
  WHERE sku IN ('DOM00','DOM01','DOM02','DOM03');
UPDATE productos SET grupo = 'Puños', subgrupo = 'Universales con contrapeso'
  WHERE sku IN ('PUNBLACK','PUNRED','PUNORGANG');
UPDATE productos SET grupo = 'Puños', subgrupo = 'Metálicos Café Racer'
  WHERE sku IN ('SBJ-10078');

UPDATE productos SET grupo = 'Escapes', subgrupo = 'SC Project'
  WHERE sku IN ('HP-EXHAUST-GBLACK','HP-EXHAUST-GSILVER','AP-SLANTED01');
UPDATE productos SET grupo = 'Escapes', subgrupo = 'Akrapovic'
  WHERE sku IN ('HP-EXHAUST-A');
UPDATE productos SET grupo = 'Escapes', subgrupo = 'Yoshimura'
  WHERE sku IN ('AP-YOSHIMURA01');

UPDATE productos SET grupo = 'Espejos', subgrupo = 'De puño'
  WHERE sku IN ('HP-SH-5003-L','ESP-CIR-001');
UPDATE productos SET grupo = 'Espejos', subgrupo = 'Tipo alerón'
  WHERE sku IN ('ALERONFINOSNK','2004-107','HSJ-20121');

UPDATE productos SET grupo = 'Protección', subgrupo = 'Guardamanos'
  WHERE sku IN ('HP-HS010','HP-Q0211','HP-Q0212','HP-Q0213');
UPDATE productos SET grupo = 'Protección', subgrupo = 'Protectores de levas'
  WHERE sku IN ('HP-Q035B1','HP-Q035B2','HP-Q035B3');
UPDATE productos SET grupo = 'Protección', subgrupo = 'Sliders'
  WHERE sku IN ('FSB-002','FSB-003');
UPDATE productos SET grupo = 'Protección', subgrupo = 'Protectores de mano'
  WHERE sku IN ('HS-30006','MELI-MLU1039263040');

UPDATE productos SET grupo = 'Carenado', subgrupo = 'Guardabarros'
  WHERE sku IN ('HP-DB004-B');
UPDATE productos SET grupo = 'Carenado', subgrupo = 'Parabrisas'
  WHERE sku IN ('HP-DF028','DFB-002');

UPDATE productos SET grupo = 'Baúles', subgrupo = 'Traseros'
  WHERE sku IN ('AP-TAILBOXLED','AP-TAILBOXSQ');

UPDATE productos SET grupo = 'Eléctrico', subgrupo = 'Señaleros LED'
  WHERE sku IN ('HP-Z0533','SEÑAL01');

UPDATE productos SET grupo = 'Matrícula', subgrupo = 'Porta matrícula rebatible'
  WHERE sku IN ('PATENTE1','CPJ-62001');

UPDATE productos SET grupo = 'Posapiés', subgrupo = 'Universales'
  WHERE sku IN ('HP-ZJ039','POSAPIE1');

UPDATE productos SET grupo = 'Soportes y bases', subgrupo = 'Soportes de celular'
  WHERE sku IN ('SOP-CEL-MAN-001','SOP-CEL-ESP-001');
UPDATE productos SET grupo = 'Soportes y bases', subgrupo = 'Gatos elevadores'
  WHERE sku IN ('GZTYJ-41046N','GZTYJ-41046R');
UPDATE productos SET grupo = 'Soportes y bases', subgrupo = 'Pata lateral'
  WHERE sku IN ('YTLY-30');

-- Los usados que quedaron de la etapa anterior del negocio (ropa, muebles, la
-- Virago) no entran en ninguna familia de accesorios.
UPDATE productos SET grupo = 'Otros'
  WHERE grupo IS NULL AND (discontinuado = true OR tipo = 'usado');
