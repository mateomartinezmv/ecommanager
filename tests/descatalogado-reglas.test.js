// Reglas del descatalogado que no pasan por la pantalla: qué columnas se escriben y qué
// productos entran en la sincronización de stock.
//
// A diferencia del resto de la carpeta, esto no abre el navegador: api/_discontinuado.js es
// un módulo puro y se puede ejercitar directo. Es el único lugar donde vive el criterio, así
// que los tres endpoints que lo usan (meli/sync-stock, shopify/sync-stock, meli/stock)
// quedan cubiertos por acá.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  camposDiscontinuado, entraEnSyncStock, FILTRO_SYNC_STOCK, normalizarMotivo, faltaMigracionMotivo,
} = require('../api/_discontinuado');

test('un descatalogado con unidades sigue sincronizando; en cero, no', () => {
  // Sigue vendiendo hasta agotarse: la publicación tiene que mostrar el stock real.
  assert.strictEqual(entraEnSyncStock({ discontinuado: true, stock_dep: 4 }), true);
  // Ya no tiene nada que ofrecer: no se le vuelve a tocar la publicación.
  assert.strictEqual(entraEnSyncStock({ discontinuado: true, stock_dep: 0 }), false);
  assert.strictEqual(entraEnSyncStock({ discontinuado: true }), false);
  // Un producto activo entra siempre, tenga o no stock.
  assert.strictEqual(entraEnSyncStock({ discontinuado: false, stock_dep: 0 }), true);
  assert.strictEqual(entraEnSyncStock({ stock_dep: 3 }), true);
});

test('el filtro de PostgREST dice lo mismo que la función', () => {
  // Si alguien cambia uno de los dos sin el otro, la base y el código dejan de coincidir.
  assert.deepStrictEqual(FILTRO_SYNC_STOCK.split(','), [
    'discontinuado.is.null', 'discontinuado.eq.false', 'stock_dep.gt.0',
  ]);
});

test('descatalogar escribe motivo, nota y fecha juntos', () => {
  const campos = camposDiscontinuado(
    { discontinuado: true, motivoDiscontinuado: 'poca_venta', notaDiscontinuado: '  parado  ', fechaDiscontinuado: '2026-10-08' },
    null,
  );
  assert.deepStrictEqual(campos, {
    discontinuado: true, motivo_discontinuado: 'poca_venta',
    nota_discontinuado: 'parado', fecha_discontinuado: '2026-10-08',
  });
});

test('un request que no habla del descatalogado no lo pisa', () => {
  // Es lo que manda el formulario de edición de producto: sin esto, guardar un producto
  // descatalogado lo reactivaba y lo devolvía a Reposición.
  const anterior = {
    discontinuado: true, motivo_discontinuado: 'poco_margen',
    nota_discontinuado: 'la comisión se come todo', fecha_discontinuado: '2026-05-01',
  };
  const campos = camposDiscontinuado({ nombre: 'Otro nombre' }, anterior);
  assert.strictEqual(campos.discontinuado, true);
  assert.strictEqual(campos.motivo_discontinuado, 'poco_margen');
  assert.strictEqual(campos.nota_discontinuado, 'la comisión se come todo');
  assert.strictEqual(campos.fecha_discontinuado, '2026-05-01');
});

test('reactivar limpia el motivo entero', () => {
  const campos = camposDiscontinuado({ discontinuado: false }, {
    discontinuado: true, motivo_discontinuado: 'poca_venta',
    nota_discontinuado: 'x', fecha_discontinuado: '2026-05-01',
  });
  assert.deepStrictEqual(campos, {
    discontinuado: false, motivo_discontinuado: null,
    nota_discontinuado: null, fecha_discontinuado: null,
  });
});

test('un motivo fuera del catálogo no entra a la base', () => {
  assert.strictEqual(normalizarMotivo('poca_venta'), 'poca_venta');
  assert.strictEqual(normalizarMotivo('inventado'), null);
  assert.strictEqual(normalizarMotivo(''), null);
  assert.strictEqual(normalizarMotivo(undefined), null);
  // Se guarda sin motivo en vez de rechazar el guardado: perder el motivo es menos grave que
  // perder el descatalogado entero.
  assert.strictEqual(camposDiscontinuado({ discontinuado: true, motivoDiscontinuado: 'inventado' }, null).motivo_discontinuado, null);
});

test('reconoce el error de "la columna todavía no existe"', () => {
  assert.strictEqual(faltaMigracionMotivo({ code: 'PGRST204' }), true);
  assert.strictEqual(faltaMigracionMotivo({ code: '42703' }), true);
  assert.strictEqual(faltaMigracionMotivo({ message: 'column productos.motivo_discontinuado does not exist' }), true);
  // Un error cualquiera no tiene que disparar el reintento sin motivo.
  assert.strictEqual(faltaMigracionMotivo({ code: '23505', message: 'duplicate key value' }), false);
  assert.strictEqual(faltaMigracionMotivo(null), false);
});
