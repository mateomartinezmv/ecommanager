-- Migration: backfill de carritos viejos (anteriores a venta_grupo)
--
-- Las ventas mostrador cargadas antes de esta feature ya venían de un carrito, pero se
-- guardaron como líneas sueltas. Se pueden reconstruir por el formato del id que usaba el
-- front: 'V' + Date.now() + <índice de la línea en el carrito>, o sea 'V' + 13 dígitos + i.
-- Una línea con índice > 0 sólo existe si el carrito tenía más de un producto, así que las
-- líneas se agrupan arrancando en cada índice 0 y siguiendo mientras el índice sea correlativo.
--
-- Guardas extra para no unir por error dos ventas distintas seguidas: misma fecha, mismo
-- método de pago, mismo cliente y menos de 5 minutos entre la primera y la última línea.

WITH m AS (
  SELECT id, created_at, fecha, metodo_pago, cliente,
         CASE WHEN id ~ '^V[0-9]{14,}$' THEN substring(id FROM 15)::int END AS idx
  FROM ventas
  WHERE canal = 'mostrador' AND venta_grupo IS NULL
),
ord AS (
  SELECT *, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM m WHERE idx IS NOT NULL
),
grp AS (
  SELECT *, SUM(CASE WHEN idx = 0 THEN 1 ELSE 0 END) OVER (ORDER BY rn) AS cart_no
  FROM ord
),
carritos AS (
  SELECT cart_no,
         'C' || substring(MIN(id) FILTER (WHERE idx = 0) FROM 2 FOR 13) AS grupo
  FROM grp
  GROUP BY cart_no
  HAVING COUNT(*) > 1
     AND MAX(idx) = COUNT(*) - 1                                        -- índices correlativos
     AND COUNT(DISTINCT fecha) = 1
     AND COUNT(DISTINCT COALESCE(metodo_pago, '')) = 1
     AND COUNT(DISTINCT COALESCE(cliente, '')) = 1
     AND EXTRACT(EPOCH FROM MAX(created_at) - MIN(created_at)) < 300
)
UPDATE ventas v
SET venta_grupo = c.grupo
FROM grp g
JOIN carritos c ON c.cart_no = g.cart_no
WHERE v.id = g.id;
