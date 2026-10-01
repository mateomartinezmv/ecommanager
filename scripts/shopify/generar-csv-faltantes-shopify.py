#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera products_export_actualizado.csv:
  · conserva las 165 filas originales del export de Shopify
  · completa el Variant SKU que faltaba en ALERONFINOSNK
  · agrega los productos que estan en MELI (cruzados por SKU del CRM) y no estaban en Shopify
  · de cada producto con varios angulos de venta, usa el angulo con mas ventas historicas

Fuentes: export de Shopify (MARTINEZ MOTOS), API de MELI (users/2715667241, 163 items)
y tabla productos del CRM (Supabase).
"""
import csv

ORIGEN = 'products_export_original.csv'
SALIDA = 'products_export_actualizado.csv'

M = 'https://http2.mlstatic.com/'

# ─────────────────────────────────────────────────────────────────────────────
# Fotos de cada angulo ganador (orden tal cual lo tiene la publicacion en MELI)
# ─────────────────────────────────────────────────────────────────────────────
FOTOS = {
 'MLU1475174212': ['D_980115-MLU115793987491_082026-O.jpg','D_629179-MLU115793987215_082026-O.jpg','D_929499-MLU114444759578_082026-O.jpg','D_911459-MLU115794165317_082026-O.jpg','D_603503-MLU114444524466_082026-O.jpg','D_986477-MLU114445022284_082026-O.jpg'],
 'MLU1475174254': ['D_978649-MLU115795076971_082026-O.jpg','D_665805-MLU114444644392_082026-O.jpg','D_992098-MLU114444994894_082026-O.jpg','D_950541-MLU115794168049_082026-O.jpg','D_729319-MLU115794846945_082026-O.jpg','D_779860-MLU115793990243_082026-O.jpg','D_632880-MLU114445201492_082026-O.jpg'],
 'MLU1475283030': ['D_796724-MLU114265312972_082026-O.jpg','D_738402-MLU114264720374_082026-O.jpg','D_777203-MLU114264630744_082026-O.jpg','D_991794-MLU114264365782_082026-O.jpg'],
 'MLU1475283052': ['D_644695-MLU114265995786_082026-O.jpg','D_636066-MLU114264720710_082026-O.jpg','D_843827-MLU115602453343_082026-O.jpg','D_744138-MLU114264366124_082026-O.jpg','D_664235-MLU114265995798_082026-O.jpg','D_776510-MLU114264572048_082026-O.jpg'],
 'MLU1503030820': ['D_828442-MLU116101041296_092026-O.jpg','D_634879-MLU117583016689_092026-O.jpg','D_684629-MLU116100806866_092026-O.jpg','D_682327-MLU116100718372_092026-O.jpg','D_837113-MLU117583016665_092026-O.jpg'],
 'MLU1503031072': ['D_793869-MLU116100822324_092026-O.jpg','D_698768-MLU116101787356_092026-O.jpg','D_867071-MLU117583766657_092026-O.jpg','D_957551-MLU117583766659_092026-O.jpg','D_624092-MLU117583406791_092026-O.jpg','D_698277-MLU116100822320_092026-O.jpg'],
 'MLU1503031074': ['D_873281-MLU116101057018_092026-O.jpg','D_745881-MLU116100733946_092026-O.jpg','D_628926-MLU116101785168_092026-O.jpg','D_801257-MLU117583032259_092026-O.jpg','D_661370-MLU117583035213_092026-O.jpg','D_834024-MLU117583414143_092026-O.jpg'],
 'MLU1504462008': ['D_791938-MLU117579603487_092026-O.jpg','D_696893-MLU116098455802_092026-O.jpg','D_839802-MLU116098012882_092026-O.jpg','D_933874-MLU116098485042_092026-O.jpg','D_881658-MLU116097724018_092026-O.jpg','D_963036-MLU117579868377_092026-O.jpg'],
 'MLU1510939608': ['D_633959-MLU116857696548_092026-O.jpg','D_720758-MLU118415085713_092026-O.jpg','D_649325-MLU116857403384_092026-O.jpg','D_849904-MLU116856670086_092026-O.jpg'],
 'MLU1510978678': ['D_759800-MLU118416535763_092026-O.jpg','D_643762-MLU118415915825_092026-O.jpg','D_846086-MLU116856912686_092026-O.jpg','D_767606-MLU118415915829_092026-O.jpg','D_636911-MLU116857293462_092026-O.jpg'],
 'MLU700264541': ['D_772232-MLU117582405873_092026-O.jpg','D_810622-MLU117582405897_092026-O.jpg','D_638693-MLU117583020857_092026-O.jpg','D_929192-MLU116101044982_092026-O.jpg','D_976777-MLU116100488818_092026-O.jpg'],
 'MLU700273387': ['D_635311-MLU116100483764_092026-O.jpg','D_978129-MLU116101039726_092026-O.jpg','D_928999-MLU117582400539_092026-O.jpg','D_758896-MLU116100716830_092026-O.jpg','D_786892-MLU116100716848_092026-O.jpg','D_901048-MLU117582400601_092026-O.jpg','D_685517-MLU116100805382_092026-O.jpg'],
}
def fotos(item_id):
    return [M + f for f in FOTOS[item_id]]

CAT_CARROCERIA = 'Vehículos y recambios > Piezas y accesorios para vehículos > Piezas para vehículos motorizados > Piezas de bastidor y carrocería para vehículos motorizados'
CAT_ESCAPE     = 'Vehículos y recambios > Piezas y accesorios para vehículos > Piezas para vehículos motorizados > Tubos de escape para vehículos motorizados'
CAT_ESPEJO     = 'Vehículos y recambios > Piezas y accesorios para vehículos > Piezas para vehículos motorizados > Espejos para vehículos motorizados'
CAT_CONTROLES  = 'Vehículos y recambios > Piezas y accesorios para vehículos > Piezas para vehículos motorizados > Controles de vehículos motorizados'


def cuerpo(que_es, para_que, instalacion):
    """Cuerpo en el formato que ya usan las fichas de la tienda."""
    return (f'<p>¿Qué es?<br>{que_es}</p>\n'
            f'<p>¿Para qué sirve?<br>{para_que}</p>\n'
            f'<p>¿Cómo se instala?<br>{instalacion}</p>')


# ─────────────────────────────────────────────────────────────────────────────
# Productos nuevos. 'variantes' lleva una entrada por SKU.
# 'angulo' = publicacion MELI elegida · 'ventas' = unidades historicas de ese angulo
# ─────────────────────────────────────────────────────────────────────────────
NUEVOS = [
  {
    'handle': 'baul-trasero-moto-45l-pp-alta-resistencia-universal-con-llave',
    'title': 'Baúl Trasero Moto 45L PP Alta Resistencia Universal Con Llave',
    'categoria': CAT_CARROCERIA,
    'tipo': 'Baúl',
    'tags': 'Accesorios para Vehículos, Baúles, Repuestos Motos y Cuatriciclos',
    'seo_title': 'Baúl Trasero Moto 45L Con Llave Universal | Martínez Motos',
    'seo_desc': 'Baúl trasero para moto de 45 litros en polipropileno reforzado, con cerradura y llave. Entran hasta 2 cascos integrales. Envío a todo Uruguay.',
    'body': cuerpo(
      'Baúl trasero para moto de 45 litros fabricado en polipropileno (PP) de alta resistencia a impactos. Mide 45 cm de ancho × 35 cm de profundidad × 32 cm de alto. Incluye cerradura con llave, llave extra, respaldo acolchado para el acompañante, soporte para la parrilla y toda la tornillería de instalación universal.',
      'Transportar carga de verdad arriba de la moto: entran hasta dos cascos integrales, mochilas, herramientas o mercadería. La estructura reforzada aguanta el uso intensivo diario, así que es la opción indicada para delivery, mensajería y viajes largos. La cerradura mantiene el contenido seguro cuando dejás la moto estacionada.',
      'Se monta sobre la parrilla trasera con el soporte y la tornillería que vienen en la caja. La base es universal y entra en la mayoría de las parrillas del mercado. Viene ya armado, listo para fijar. Tiempo estimado: 20 minutos con herramientas básicas.'),
    'variantes': [
      {'sku': 'AP-TAILBOXSQ', 'angulo': 'MLU1475174212', 'ventas': 13,
       'precio': '3990.00', 'costo': '948.00', 'qty': 3, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'baul-trasero-moto-28l-abs-clasico-seguro-universal-con-llave',
    'title': 'Baúl Trasero Moto 28L ABS Clásico Seguro Universal Con Llave',
    'categoria': CAT_CARROCERIA,
    'tipo': 'Baúl',
    'tags': 'Accesorios para Vehículos, Baúles, Repuestos Motos y Cuatriciclos',
    'seo_title': 'Baúl Trasero Moto 28L ABS Con Llave | Martínez Motos',
    'seo_desc': 'Baúl trasero para moto de 28 litros en ABS de alta resistencia, con cerradura y llave. Entra un casco integral. Envío a todo Uruguay.',
    'body': cuerpo(
      'Baúl trasero para moto de 28 litros en plástico ABS resistente a impactos y a los rayos UV, con el diseño clásico que combina con cualquier modelo. Incluye cerradura con llave, respaldo acolchado para el acompañante, kit de fijación y manual de instalación.',
      'Sumar lugar para guardar sin perder comodidad al viajar: entra un casco integral, documentación, herramientas o las compras del día. El cierre con llave protege lo que dejás adentro mientras estás lejos de la moto. Es una de las opciones más elegidas para uso urbano, delivery y viajes cortos.',
      'Se fija sobre la parrilla trasera con el kit incluido. La base es universal y se adapta a la gran mayoría de las motos con parrilla estándar. Tiempo estimado: 20 minutos con herramientas básicas.'),
    'variantes': [
      {'sku': 'AP-TAILBOXLED', 'angulo': 'MLU1475174254', 'ventas': 10,
       'precio': '1750.00', 'costo': '800.00', 'qty': 0, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'escape-yoshimura-fibra-carbono-universal-moto-deportivo-51mm',
    'title': 'Escape Yoshimura Fibra Carbono Universal Moto Deportivo 51mm',
    'categoria': CAT_ESCAPE,
    'tipo': 'Escape',
    'tags': 'Accesorios para Vehículos, Chasis, Escapes',
    'seo_title': 'Escape Yoshimura Fibra Carbono 51mm Moto | Martínez Motos',
    'seo_desc': 'Escape estilo Yoshimura en fibra de carbono, boca de 51mm, universal para moto deportiva y naked. Sonido más grave. Envío a todo Uruguay.',
    'body': cuerpo(
      'Escape estilo Yoshimura con cuerpo en fibra de carbono y salida en acero/aluminio. Boca de 51 mm, terminación en fibra a la vista y alta resistencia térmica. Diseño universal de línea deportiva racing.',
      'Darle a la moto sonido y estética deportiva: entrega un sonido más grave y deportivo que el escape de fábrica y reduce peso respecto al sistema original. El salto estético es inmediato en cualquier moto deportiva o naked.',
      'Se monta en el lugar del silenciador original. Requiere adaptador o kit de fijación según el modelo de moto: verificá el diámetro de salida de tu caño antes de comprar. Se recomienda instalación con herramientas básicas o en taller.'),
    'variantes': [
      {'sku': 'AP-YOSHIMURA01', 'angulo': 'MLU1475283030', 'ventas': 0,
       'precio': '5890.00', 'costo': '2556.00', 'qty': 3, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'escape-sc-project-boca-inclinada-51mm-negro-universal-moto',
    'title': 'Escape SC Project Boca Inclinada 51mm Negro Universal Moto',
    'categoria': CAT_ESCAPE,
    'tipo': 'Escape',
    'tags': 'Accesorios para Vehículos, Chasis, Escapes',
    'seo_title': 'Escape SC Project Boca Inclinada 51mm Negro | Martínez Motos',
    'seo_desc': 'Escape estilo SC Project boca inclinada, terminación full black y boca de 51mm. Universal para moto deportiva, naked y street.',
    'body': cuerpo(
      'Escape estilo SC Project con diseño de boca inclinada (slant cut) y terminación full black. Cuerpo en acero inoxidable con acabado resistente al calor y a la corrosión. Boca de 51 mm. Medidas aproximadas: 300 mm de largo total × 180 mm de cuerpo × 85 mm de diámetro externo.',
      'Un cambio estético directo y agresivo, más una mejora de sonido respecto al escape original. La terminación en negro mate combina con motos deportivas, naked y street sin quedar estridente.',
      'Se instala en el lugar del silenciador original mediante el sistema de fijación correspondiente a tu moto. Instalación sencilla con herramientas básicas: verificá antes el diámetro de salida del caño de tu moto.'),
    'variantes': [
      {'sku': 'AP-SLANTED01', 'angulo': 'MLU1475283052', 'ventas': 2,
       'precio': '2590.00', 'costo': '1107.00', 'qty': 0, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'espejos-retrovisores-de-manubrio-para-moto-22-mm',
    'title': 'Espejos Retrovisores De Manubrio Para Moto 22 Mm',
    'categoria': CAT_ESPEJO,
    'tipo': 'Espejos',
    'tags': 'Accesorios para Vehículos, Espejos, Repuestos Motos y Cuatriciclos',
    'seo_title': 'Espejos Retrovisores De Manubrio Moto 22mm | Martínez Motos',
    'seo_desc': 'Par de espejos retrovisores circulares de puño para manubrio de moto 7/8 (22 mm). Ajustables, acabado mate. Envío a todo Uruguay.',
    'body': cuerpo(
      'Par de espejos retrovisores circulares de puño para montar en el manubrio, en la medida universal de 7/8 de pulgada (22 mm), la más usada en motos de calle, motos chicas y utilitarias. Vienen izquierdo y derecho, con acabado de superficie mate. Diseño circular clásico, prolijo y discreto.',
      'Cambiar los espejos originales por algo más simple y limpio sin perder visibilidad. Son ajustables: podés girar el brazo y el espejo hasta encontrar el ángulo que mejor te deje ver lo que viene atrás. El acabado mate evita reflejos molestos con el sol de frente.',
      'Se montan directamente en el manubrio. Antes de comprar medí el diámetro del manubrio en la zona donde van montados y confirmá que trabaje en 7/8 de pulgada (22 mm). Tiempo estimado: 10 minutos con herramientas básicas.'),
    'variantes': [
      {'sku': 'ESP-CIR-001', 'angulo': 'MLU1504462008', 'ventas': 1,
       'precio': '1090.00', 'costo': '334.00', 'qty': 6, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'manillar-para-moto-custom-chopper-en-acero-cromado-y-negro',
    'title': 'Manillar Para Moto Custom Chopper En Acero Cromado Y Negro',
    'categoria': CAT_CONTROLES,
    'tipo': 'Manillar',
    'tags': 'Chasis, Puños y Manillares, Repuestos Motos y Cuatriciclos',
    'seo_title': 'Manillar Custom Chopper Acero Moto 22mm | Martínez Motos',
    'seo_desc': 'Manillar alto estilo custom chopper en acero, 70 cm de ancho, universal 7/8 (22 mm). Disponible en negro y plateado.',
    'body': cuerpo(
      'Manillar alto estilo custom chopper fabricado en acero, de 70 cm de ancho y 2,5 cm de diámetro de tubo (7/8 de pulgada, 22 mm). Disponible en dos terminaciones: negro mate y cromado plateado. Diseño ergonómico pensado para mejorar el agarre y el control.',
      'Cambiar la postura de manejo y la imagen de la moto: la posición más alta y abierta del manillar custom descansa los hombros en ciudad y le da a la moto un aire clásico y personalizado. También sirve para reemplazar un manubrio golpeado o torcido.',
      'Se reemplaza el manillar original aflojando los soportes del tubo superior. Antes de comprar medí el diámetro del manubrio que tenés en la zona de los puños y los mandos: si es de 22 mm, este modelo te va. Verificá también que los cables y el cableado de los mandos tengan largo suficiente para la nueva posición. Se entrega sin puños, espejos ni mandos.'),
    'variantes': [
      {'sku': 'MAN-78-V2-NEG-001', 'angulo': 'MLU1503031072', 'ventas': 0,
       'precio': '690.00', 'costo': '237.00', 'qty': 5, 'opt_name': 'Color', 'opt_value': 'Negro'},
      {'sku': 'MAN-78-V2-PLA-001', 'angulo': 'MLU1503031074', 'ventas': 0,
       'precio': '690.00', 'costo': '237.00', 'qty': 5, 'opt_name': 'Color', 'opt_value': 'Plateado'},
    ],
  },
  {
    'handle': 'manillar-cafe-racer-universal-7-8-22mm-recto-negro',
    'title': 'Manillar Café Racer Universal 7/8 22mm Recto Negro',
    'categoria': CAT_CONTROLES,
    'tipo': 'Manillar',
    'tags': 'Chasis, Puños y Manillares, Repuestos Motos y Cuatriciclos',
    'seo_title': 'Manillar Café Racer Recto Aluminio 22mm | Martínez Motos',
    'seo_desc': 'Manillar café racer universal 7/8 (22 mm) recto en aluminio negro. Posición de manejo más baja y deportiva. Envío a todo Uruguay.',
    'body': cuerpo(
      'Manillar recto universal de 22 mm (7/8 de pulgada) fabricado en aluminio, liviano y con buena rigidez para el uso diario. Terminación en negro, que combina con puños, espejos y controles oscuros.',
      'Ganar una posición de manejo más baja y deportiva, estilo café racer, sin modificar la moto. También sirve para reemplazar un manubrio golpeado o torcido, o para darle a la moto una estética más despojada y prolija.',
      'Se reemplaza el manillar original aflojando los soportes del tubo superior. Antes de comprar medí el diámetro del manubrio en la zona de los puños y de los mandos: tiene que ser de 22 mm. Verificá también que los cables y el cableado de los mandos tengan largo suficiente para la nueva posición. Se entrega sin puños, espejos ni mandos.'),
    'variantes': [
      {'sku': 'MAN-78-V3-NEG-001', 'angulo': 'MLU700264541', 'ventas': 0,
       'precio': '890.00', 'costo': '263.00', 'qty': 5, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'soporte-celular-moto-universal-espejo-negro-ajustable',
    'title': 'Soporte Celular Moto Universal Espejo Negro Ajustable',
    'categoria': CAT_CARROCERIA,
    'tipo': 'Soporte',
    'tags': 'Accesorios para Vehículos, Repuestos Motos y Cuatriciclos, Soportes de Celular',
    'seo_title': 'Soporte Celular Moto Para Espejo Ajustable | Martínez Motos',
    'seo_desc': 'Soporte de celular para moto que se fija en la base del espejo retrovisor. Universal y ajustable, en plástico negro. Envío a todo Uruguay.',
    'body': cuerpo(
      'Soporte para llevar el celular a la vista arriba de la moto, el scooter o el cuatriciclo, que se fija en la base del espejo retrovisor. Es universal y ajustable: se adapta a distintos anchos de teléfono y a cualquier vehículo que tenga espejo con rosca. Fabricado en plástico negro, resistente y liviano.',
      'Usar el celular como GPS sin perder de vista el camino: la pantalla queda al frente y a la altura de la vista, así seguís el recorrido en ruta o en ciudad de una mirada. Al ir en el espejo no ocupa lugar en el manubrio ni tapa el tablero. Útil para paseos largos, viajes a otra ciudad y para quien trabaja con apps de reparto.',
      'Se monta en la rosca de la base del espejo retrovisor, entre el espejo y el manillar. Viene listo para montar, no requiere perforar nada. Tiempo estimado: 5 minutos con una llave.'),
    'variantes': [
      {'sku': 'SOP-CEL-ESP-001', 'angulo': 'MLU1503030820', 'ventas': 5,
       'precio': '490.00', 'costo': '88.00', 'qty': 92, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
  {
    'handle': 'soporte-celular-moto-universal-manillar-negro-ajustable',
    'title': 'Soporte Celular Moto Universal Manillar Negro Ajustable',
    'categoria': CAT_CARROCERIA,
    'tipo': 'Soporte',
    'tags': 'Accesorios para Vehículos, Repuestos Motos y Cuatriciclos, Soportes de Celular',
    'seo_title': 'Soporte Celular Moto Para Manillar Ajustable | Martínez Motos',
    'seo_desc': 'Soporte de celular para manubrio de moto, universal y ajustable, en plástico negro. Ideal para delivery y apps de navegación.',
    'body': cuerpo(
      'Soporte para llevar el celular a la vista sobre el manubrio de la moto. Es universal y ajustable: la sujeción se abre y cierra para tomar celulares de distintos tamaños, y el mismo sistema lo fija con firmeza a manubrios tubulares de distinto diámetro. Fabricado en plástico negro, de línea discreta.',
      'Seguir el mapa y los pedidos sin soltar el manillar. Va en moto de calle, scooter, ciclomotor, cross, enduro y cuatriciclo con manubrio tubular. Pensado para quien hace delivery o trabaja con aplicaciones, y también como reemplazo cuando el soporte anterior se aflojó o se rompió.',
      'Se abraza al manubrio y se ajusta con el tornillo del soporte, dejando la pantalla en la posición que más te sirva para manejar. No requiere perforar nada. Tiempo estimado: 5 minutos con una llave Allen.'),
    'variantes': [
      {'sku': 'SOP-CEL-MAN-001', 'angulo': 'MLU700273387', 'ventas': 1,
       'precio': '490.00', 'costo': '88.00', 'qty': 97, 'opt_name': 'Title', 'opt_value': 'Default Title'},
    ],
  },
]

# ─────────────────────────────────────────────────────────────────────────────
# Variantes nuevas dentro de handles que ya existen en la tienda
# ─────────────────────────────────────────────────────────────────────────────
VARIANTES_EXTRA = [
  {'handle': 'punos-domino-para-moto-manubrio-goma-antideslizante',
   'sku': 'DOM04', 'angulo': 'MLU1510939608', 'ventas': 0, 'opt_value': 'Verde',
   'precio': '450.00', 'costo': '117.20', 'qty': 5},
  {'handle': 'punos-universales-antideslizantes-con-contrapesos-anticaidas',
   'sku': 'PUNYELLOW', 'angulo': 'MLU1510978678', 'ventas': 0, 'opt_value': 'Dorado',
   'precio': '990.00', 'costo': '180.00', 'qty': 5},
]

# ─────────────────────────────────────────────────────────────────────────────

def main():
    with open(ORIGEN, encoding='utf-8', newline='') as f:
        lector = csv.DictReader(f)
        columnas = lector.fieldnames
        filas = list(lector)

    vacia = lambda: {c: '' for c in columnas}

    # ── 1. Completar el SKU que faltaba en el producto de espejos finos ──────
    arreglos = 0
    for r in filas:
        if (r['Handle'] == 'espejos-moto-tipo-aleron-finos-universales-naked-y-otras'
                and r['Option1 Value'].strip() and not r['Variant SKU'].strip()):
            r['Variant SKU'] = 'ALERONFINOSNK'
            arreglos += 1

    # ── 2. Variantes nuevas en handles existentes ───────────────────────────
    # Se insertan justo despues de la ultima variante de ese handle; las fotos
    # del color nuevo van al final del bloque de imagenes del producto.
    for v in VARIANTES_EXTRA:
        bloque = [i for i, r in enumerate(filas) if r['Handle'] == v['handle']]
        ultima_variante = max(i for i in bloque if filas[i]['Variant SKU'].strip())
        pos_max = max(int(float(filas[i]['Image Position']))
                      for i in bloque if filas[i]['Image Position'].strip())
        imgs = fotos(v['angulo'])

        fila = vacia()
        fila.update({
            'Handle': v['handle'],
            'Option1 Value': v['opt_value'],
            'Variant SKU': v['sku'],
            'Variant Grams': '0.0',
            'Variant Inventory Tracker': 'shopify',
            'Variant Inventory Qty': str(v['qty']),
            'Variant Inventory Policy': 'deny',
            'Variant Fulfillment Service': 'manual',
            'Variant Price': v['precio'],
            'Variant Requires Shipping': 'true',
            'Variant Taxable': 'true',
            'Image Src': imgs[0],
            'Image Position': str(pos_max + 1),
            'Variant Image': imgs[0],
            'Variant Weight Unit': 'kg',
            'Cost per item': v['costo'],
        })
        nuevas = [fila]
        for n, url in enumerate(imgs[1:], start=pos_max + 2):
            extra = vacia()
            extra.update({'Handle': v['handle'], 'Image Src': url, 'Image Position': str(n)})
            nuevas.append(extra)

        filas[ultima_variante + 1:ultima_variante + 1] = nuevas

    # ── 3. Productos nuevos ─────────────────────────────────────────────────
    for p in NUEVOS:
        # Las fotos del producto son las del angulo ganador de cada variante,
        # en orden de variante y sin repetir.
        galeria, vistas = [], set()
        for v in p['variantes']:
            for url in fotos(v['angulo']):
                if url not in vistas:
                    vistas.add(url)
                    galeria.append(url)

        nuevas = []
        for n, v in enumerate(p['variantes']):
            fila = vacia()
            portada = fotos(v['angulo'])[0]
            if n == 0:
                fila.update({
                    'Title': p['title'],
                    'Body (HTML)': p['body'],
                    'Vendor': 'Martinez Motos',
                    'Product Category': p['categoria'],
                    'Type': p['tipo'],
                    'Tags': p['tags'],
                    'Published': 'true',
                    'Option1 Name': v['opt_name'],
                    'SEO Title': p['seo_title'],
                    'SEO Description': p['seo_desc'],
                    'Gift Card': 'false',
                    'Status': 'active',
                })
            fila.update({
                'Handle': p['handle'],
                'Option1 Value': v['opt_value'],
                'Variant SKU': v['sku'],
                'Variant Grams': '0.0',
                'Variant Inventory Tracker': 'shopify',
                'Variant Inventory Qty': str(v['qty']),
                'Variant Inventory Policy': 'deny',
                'Variant Fulfillment Service': 'manual',
                'Variant Price': v['precio'],
                'Variant Requires Shipping': 'true',
                'Variant Taxable': 'true',
                'Variant Image': portada,
                'Variant Weight Unit': 'kg',
                'Cost per item': v['costo'],
            })
            nuevas.append(fila)

        # Las imagenes del producto se reparten: una por fila de variante y el
        # resto en filas sueltas, como lo hace el propio export de Shopify.
        for i, url in enumerate(galeria):
            if i < len(nuevas):
                nuevas[i]['Image Src'] = url
                nuevas[i]['Image Position'] = str(i + 1)
            else:
                extra = vacia()
                extra.update({'Handle': p['handle'], 'Image Src': url, 'Image Position': str(i + 1)})
                nuevas.append(extra)

        filas.extend(nuevas)

    with open(SALIDA, 'w', encoding='utf-8', newline='') as f:
        escritor = csv.DictWriter(f, fieldnames=columnas)
        escritor.writeheader()
        escritor.writerows(filas)

    skus_nuevos = ([v['sku'] for p in NUEVOS for v in p['variantes']]
                   + [v['sku'] for v in VARIANTES_EXTRA])
    print(f'{SALIDA}')
    print(f'  filas: {len(filas)} (originales 165 + {len(filas) - 165} nuevas)')
    print(f'  productos nuevos: {len(NUEVOS)} handles')
    print(f'  variantes nuevas en handles existentes: {len(VARIANTES_EXTRA)}')
    print(f'  SKUs agregados ({len(skus_nuevos)}): {", ".join(sorted(skus_nuevos))}')
    print(f'  SKU completado en filas existentes: {arreglos} (ALERONFINOSNK)')


if __name__ == '__main__':
    main()
