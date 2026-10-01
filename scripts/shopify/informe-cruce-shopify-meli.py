#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Informe del cruce Shopify ↔ MELI por SKU del CRM."""
import csv

# (sku_crm, nombre_crm, estado_cruce, pubs_meli, angulo_elegido, ventas_angulo, ventas_sku, detalle)
CRUCE = [
 # ── Agregados al CSV: estan en MELI con SKU del CRM y no estaban en Shopify ──
 ('AP-TAILBOXSQ','Baúl Trasero Moto 45L PP Alta Resistencia Universal Con Llave','agregado',3,'MLU1475174212',13,14,'3 angulos; gana la original'),
 ('AP-TAILBOXLED','Baúl Trasero Moto 28L ABS Clásico Seguro Universal Con Llave','agregado',3,'MLU1475174254',10,15,'3 angulos pausados, stock 0; gana MLU1475174254 (10) sobre la principal MLU1475174210 (5)'),
 ('AP-YOSHIMURA01','Escape Yoshimura Fibra Carbono Universal Moto Deportivo 51mm','agregado',3,'MLU1475283030',0,0,'3 angulos en 0; se usa la principal del CRM'),
 ('AP-SLANTED01','Escape SC Project Boca Inclinada 51mm Negro Universal Moto','agregado',3,'MLU1475283052',2,2,'3 angulos pausados, stock 0; gana la original'),
 ('ESP-CIR-001','Espejos de Puño Circulares Moto Universal Manillar 7/8 Negro','agregado',3,'MLU1504462008',1,2,'empate 1-1 con MLU1504436384; desempata por venta mas reciente (25/09 vs 23/09)'),
 ('MAN-78-V2-NEG-001','Manillar Moto Universal 7/8 22mm Alto Negro Antideslizante','agregado',3,'MLU1503031072',0,0,'3 angulos en 0; se usa la principal. Variante Negro del producto nuevo'),
 ('MAN-78-V2-PLA-001','Manillar Moto Universal 7/8 22mm Alto Plateado Antideslizante','agregado',3,'MLU1503031074',0,0,'3 angulos en 0; se usa la principal. Variante Plateado del mismo producto'),
 ('MAN-78-V3-NEG-001','Manillar Café Racer Universal 7/8 22mm Recto Negro','agregado',3,'MLU700264541',0,0,'3 angulos en 0; se usa la principal. OJO: 2 de sus angulos estan etiquetados en MELI con SKU MAN-78-V3-PLA-001, que no existe en el CRM'),
 ('SOP-CEL-ESP-001','Soporte Celular Moto Universal Espejo Negro Ajustable','agregado',3,'MLU1503030820',5,6,'3 angulos; gana la principal'),
 ('SOP-CEL-MAN-001','Soporte Celular Moto Universal Manillar Negro Ajustable','agregado',3,'MLU700273387',1,2,'empate 1-1 con MLU1504441600; desempata por venta mas reciente (30/09 vs 28/09)'),
 ('DOM04','Puños Domino Para Moto Manubrio Goma Antideslizante Verde','agregado como variante',3,'MLU1510939608',0,0,'color nuevo del handle punos-domino-para-moto-manubrio-goma-antideslizante'),
 ('PUNYELLOW','Puños Universales Antideslizantes Con Contrapesos Anticaídas Dorado','agregado como variante',3,'MLU1510978678',0,0,'color nuevo del handle punos-universales-antideslizantes-con-contrapesos-anticaidas'),

 # ── Ya estaba en Shopify pero sin SKU: se completo, no se duplico ──
 ('ALERONFINOSNK','Espejos Moto Tipo Alerón Finos Universales Naked Y Otras','SKU completado',3,'MLU1327525424',18,18,'el producto ya estaba en Shopify (handle espejos-moto-tipo-aleron-finos-...) con Variant SKU vacio: se completo en vez de crear un duplicado'),

 # ── Ignorados por pedido: tornillos/extensores del CRM sin publicacion en MELI ──
 *[(sku, nombre, 'ignorado (sin MELI)', 0, '', 0, 0, 'extensor con rosca, sin publicacion en MELI: ignorado por pedido')
   for sku, nombre in [
     ('EXT-ESP-10F-10F-001','Extensor Espejo Moto Rosca 10mm Int/Ext Horario Universal'),
     ('EXT-ESP-10F-10R-001','Extensor Espejo Moto Rosca 10mm Int Hor / Ext Antihor'),
     ('EXT-ESP-10F-8F-001','Extensor Espejo Moto Rosca 10mm Int Hor / 8mm Ext Hor'),
     ('EXT-ESP-10F-8R-001','Extensor Espejo Moto Rosca 10mm Int Hor / 8mm Ext Antihor'),
     ('EXT-ESP-10R-10F-001','Extensor Espejo Moto Rosca 10mm Int Antihor / Ext Hor'),
     ('EXT-ESP-10R-10R-001','Extensor Espejo Moto Rosca 10mm Int/Ext Antihorario Univ'),
     ('EXT-ESP-10R-8F-001','Extensor Espejo Moto Rosca 10mm Int Antihor / 8mm Ext'),
     ('EXT-ESP-10R-8R-001','Extensor Espejo Moto Rosca 10mm Int/8mm Ext Antihorario'),
     ('EXT-ESP-8F-10F-001','Extensor Espejo Moto Rosca 8mm Int Hor / 10mm Ext Hor'),
     ('EXT-ESP-8F-10R-001','Extensor Espejo Moto Rosca 8mm Int Hor / 10mm Ext Antihor'),
     ('EXT-ESP-8F-8F-001','Extensor Espejo Moto Rosca 8mm Int/Ext Horario Universal'),
     ('EXT-ESP-8F-8R-001','Extensor Espejo Moto Rosca 8mm Int Hor / Ext Antihor'),
     ('EXT-ESP-8R-10F-001','Extensor Espejo Moto Rosca 8mm Int Antihor / 10mm Ext'),
     ('EXT-ESP-8R-10R-001','Extensor Espejo Moto Rosca 8mm Int/10mm Ext Antihorario'),
     ('EXT-ESP-8R-8F-001','Extensor Espejo Moto Rosca 8mm Int Antihor / Ext Hor'),
     ('EXT-ESP-8R-8R-001','Extensor Espejo Moto Rosca 8mm Int/Ext Antihorario Univ'),
   ]],

 # ── Descartados: el cruce por SKU los marcaria como faltantes pero no lo son ──
 ('MELI-MLU1039263040','Protector De Correa De Mano Universal Para Deportes (ficha de catalogo)','descartado (duplicado de HS-30006)',2,'',0,0,'ficha duplicada en el CRM: la publicacion MLU1039263040 lleva SELLER_SKU HS-30006, que ya esta en Shopify'),
 ('MELI-MLU1070715098','Yamaha Virago 125cc Con Motor 250cc','descartado (fuera de catalogo)',0,'',0,0,'discontinuado y sin publicacion viva en MELI: no es accesorio de la tienda'),
 ('MELI-MLU1312907110','Cómoda Aparador Multiuso 5 Cajones','descartado (fuera de catalogo)',0,'',0,0,'discontinuado y sin publicacion viva en MELI'),
 ('MELI-MLU1327530580','Campera Nike Retro Rompevientos','descartado (fuera de catalogo)',0,'',0,0,'discontinuado y sin publicacion viva en MELI'),
 ('MELI-MLU1346576940','Championes Nike Air More Uptempo 96','descartado (fuera de catalogo)',0,'',0,0,'discontinuado y sin publicacion viva en MELI'),
]

# Publicaciones de MELI que no se pueden cruzar: no tienen SKU ni ficha en el CRM
SIN_SKU = [
 ('MLU1505482800','Volante Logitech G Kit G29 + Palanca De Cambios','closed',1),
 ('MLU1314531996','Set Cambiador Bebé Estructura Casita Con Chichonera','active',0),
 ('MLU1505422524','Alforjas Semi Rigidas Para Moto Komine','paused',0),
 ('MLU1505470262','Cinturón Inzer Maestro Levantamiento De Pesas','paused',0),
 ('MLU1505483122','Muñequeras Inzer Atomic Wraps Powerlifting','active',0),
 ('MLU690817651','Borcegos De Cuero Negros Para Mujer Con Plataforma','active',0),
 ('MLU695246803','Championes adidas Superstar Mujer Gamuza','active',0),
 ('MLU698483829','Casco Integral Agv K3 Sv','paused',0),
 ('MLU698509027','Campera Cuero Moto Agvsport Pistera','paused',0),
 ('MLU698522097','Campera Puffer Nike Negra Unisex','paused',0),
 ('MLU699762377','Pantalón Moto Protecciones 4 Estaciones Torque Revo','paused',0),
]


def main():
    with open('informe-cruce.csv', 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['SKU CRM','Nombre CRM','Resultado','Publicaciones MELI',
                    'Angulo elegido','Ventas del angulo','Ventas del SKU','Detalle'])
        w.writerows(CRUCE)
        w.writerow([])
        w.writerow(['Publicaciones de MELI sin SKU del CRM (no cruzables)'])
        w.writerow(['Item MELI','Titulo','Estado','Vendidos'])
        w.writerows(SIN_SKU)

    agregados = sum(1 for r in CRUCE if r[2].startswith('agregado'))
    print(f'informe-cruce.csv · {len(CRUCE)} SKUs del CRM evaluados, '
          f'{agregados} agregados, {len(SIN_SKU)} publicaciones sin SKU')


if __name__ == '__main__':
    main()
